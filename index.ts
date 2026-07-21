import express from "express";

const app = express();
const PORT = process.env.PORT || 8888;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.render("index");
});

app.listen(PORT, () => {
  console.log(`NEXUS is running on http://localhost:${PORT}`);
});
