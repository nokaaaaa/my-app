import "dotenv/config";
import express from "express";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

// DB 接続の準備（Prisma 7 のお作法じゃ）
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter, log: ["query"] });

const app = express();
const PORT = process.env.PORT || 8888;

// EJS を使う設定
app.set("view engine", "ejs");
app.set("views", "./views");
// フォームから送られたデータを受け取れるようにする設定
app.use(express.urlencoded({ extended: true }));

// 一覧表示のルート
app.get("/", async (req, res) => {
  const users = await prisma.user.findMany();
  res.render("index", { users });
});

// ユーザー追加のルート
app.post("/users", async (req, res) => {
  const name = req.body.name;
  // フォームから送られた年齢を数値に変換する（空なら null）
  const age = req.body.age ? Number(req.body.age) : null;

  if (name) {
    const newUser = await prisma.user.create({
      data: { name, age }
    });
    console.log("追加されたユーザー:", newUser);
  }
  res.redirect("/");
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
