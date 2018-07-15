express = require("express")()
port = process.env.PORT || 3000

express.get("/:id?/:size?", (req, res) ->
  start = new Date()
  id = req.params.id || "Steve"
  size = Math.min(1024, Math.max(8, parseInt(req.params.size) || 8))
  renderFor(id, size)
    .then((buf) ->
      res.set("Content-Type", "image/png")
      res.status(200).send(buf)
      "OK")
    .catch((err) ->
      res.set("Content-Type", "text/plain")
      res.status(500).send(err)
      "ERROR")
    .then((status) ->
      duration = new Date().getTime() - start.getTime()
      ip = req.get("CF-Connecting-IP") || req.ip
      console.log("[#{status}] #{ip} -> /#{id}/#{size} (#{duration}ms)")))

express.enable("trust proxy", true)
express.listen(port, () -> console.log("[INFO] Listening on #{port}..."))
