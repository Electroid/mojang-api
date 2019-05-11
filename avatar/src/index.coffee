reply = (req, res) ->
  [id, size] = req.url.split("/")[1..2]
  id = (id || "Steve").trim()
  size = Math.min(1024, Math.max(8, parseInt(size) || 8))
  render(id, size)
    .then((buf) ->
      [200, buf])
    .catch((err) ->
      render("Steve", size)
        .then((buf) ->
          [err.statusCode, buf]))
    .then(([code, buf]) ->
      res.type("image/png")
      res.status(code).send(buf))
    .catch((err) ->
      res.status(500).end()
      console.error(err))

try
  express = require("express")()
  express.get("/:id?/:size?", (req, res) ->
    reply(req, res))
  express.get("/robots.txt", (req, res) ->
    res.type("text/plain")
    res.send("User-agent: *\nDisallow: /"))
  express.enable("trust proxy", true)
  express.listen(80, () -> console.log("[INFO] Listening..."))
catch err
  exports.reply = (req, res) -> reply(req, res)
  console.log("[WARN] Express is not loaded, using serverless implementation...")
