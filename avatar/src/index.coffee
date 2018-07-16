express = require("express")()

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
      unless id == "Steve"
        console.log("[#{status}] #{ip} -> /#{id}/#{size} (#{duration}ms)")))

express.enable("trust proxy", true)
express.listen(80, () -> console.log("[INFO] Listening..."))
