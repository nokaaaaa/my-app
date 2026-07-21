import "dotenv/config";
import express, { type Request, type Response } from "express";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
const scrypt = promisify(scryptCallback);
const app = express();
const PORT = Number(process.env.PORT) || 8888;
const SESSION_COOKIE = "nexus_session";
const SESSION_DAYS = 30;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "300kb" }));

function readCookie(req: Request, name: string) {
  const cookies = req.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function currentUser(req: Request) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true }
  });
  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    return null;
  }
  return session.user;
}

async function createSession(res: Response, userId: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { tokenHash: tokenHash(token), expiresAt, userId } });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt
  });
}

function sameOrigin(req: Request) {
  const origin = req.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === req.get("host"); } catch { return false; }
}

function authPage(res: Response, mode: "login" | "register", error = "", values = {}) {
  return res.status(error ? 400 : 200).render("auth", { mode, error, values });
}

app.get("/login", async (req, res) => {
  if (await currentUser(req)) return res.redirect("/");
  authPage(res, "login");
});

app.get("/register", async (req, res) => {
  if (await currentUser(req)) return res.redirect("/");
  authPage(res, "register");
});

app.post("/register", async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).send("Forbidden");
  const name = String(req.body.name ?? "").trim();
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  if (name.length < 1 || name.length > 40) return authPage(res, "register", "名前は1〜40文字で入力してください。", { name, email });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return authPage(res, "register", "有効なメールアドレスを入力してください。", { name, email });
  if (password.length < 8 || password.length > 128) return authPage(res, "register", "パスワードは8〜128文字で入力してください。", { name, email });
  try {
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        account: { create: { email, passwordHash } }
      }
    });
    await createSession(res, user.id);
    return res.redirect("/");
  } catch (error: any) {
    if (error?.code === "P2002") return authPage(res, "register", "このメールアドレスはすでに登録されています。", { name, email });
    console.error(error);
    return authPage(res, "register", "登録に失敗しました。時間をおいて再度お試しください。", { name, email });
  }
});

app.post("/login", async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).send("Forbidden");
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const account = await prisma.account.findUnique({ where: { email }, include: { user: true } });
  if (!account || !(await verifyPassword(password, account.passwordHash))) {
    return authPage(res, "login", "メールアドレスまたはパスワードが正しくありません。", { email });
  }
  await createSession(res, account.user.id);
  return res.redirect("/");
});

app.post("/logout", async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).send("Forbidden");
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/login");
});

app.get("/", async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect("/login");
  const initials = user.name.slice(0, 2).toUpperCase();
  const stateJson = JSON.stringify(user.taskState ?? null).replace(/</g, "\\u003c");
  res.render("index", { user, initials, stateJson });
});

app.put("/api/state", async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "ログインが必要です" });
  const { tasks, links } = req.body ?? {};
  if (!Array.isArray(tasks) || !Array.isArray(links) || tasks.length > 500 || links.length > 2000) {
    return res.status(400).json({ error: "保存データの形式が正しくありません" });
  }
  const taskIds = new Set<string>();
  const validTasks = tasks.every((task: any) => {
    if (!task || typeof task !== "object" || typeof task.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id) || taskIds.has(task.id)) return false;
    taskIds.add(task.id);
    return typeof task.title === "string" && task.title.length >= 1 && task.title.length <= 100
      && Number.isFinite(task.x) && Number.isFinite(task.y) && task.x >= 0 && task.x <= 100 && task.y >= 0 && task.y <= 100;
  });
  const validLinks = links.every((link: any) => Array.isArray(link) && link.length === 4
    && taskIds.has(link[0]) && taskIds.has(link[1])
    && ["blocks", "related", "supports"].includes(link[2])
    && ["cyan", "violet", "lime", "orange", "pink"].includes(link[3]));
  if (!validTasks || !validLinks) return res.status(400).json({ error: "タスクデータに不正な値があります" });
  await prisma.user.update({ where: { id: user.id }, data: { taskState: { tasks, links } } });
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

app.use((_req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => {
  console.log(`NEXUS is running on http://localhost:${PORT}`);
});
