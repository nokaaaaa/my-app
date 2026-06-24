import http from "node:http";

// Render などの環境では PORT 指定があるため、それを使うようにする
const PORT = process.env.PORT || 8888;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 日本語が文字化けしないよう charset を指定
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  if (url.pathname === "/") {
    console.log("GET /");
    res.writeHead(200);
    res.end("こんにちは！");
  } else if (url.pathname === "/ask") {
    console.log("GET /ask");
    const q = url.searchParams.get("q") ?? "なし";
    res.writeHead(200);
    res.end(`お主の質問は '${q}' じゃな？`);
  } else {
    res.writeHead(404);
    res.end("ページが見つからんぞ");
  }
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
