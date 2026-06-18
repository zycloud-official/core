const express = require("express");

const app = express();
app.get("/", (_req, res) => res.send("hello from node"));
app.listen(3000, "0.0.0.0", () => console.log("listening on 3000"));
