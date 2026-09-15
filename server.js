import app from "./src/app.js";

const port = Number(process.env.PORT || 3000);

app.listen(port, "127.0.0.1", () => {
  console.log(`[Allm4 License Server] listening on http://127.0.0.1:${port}`);
});
