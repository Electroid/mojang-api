exports.get = (req, res) ->
  [id, size] = req.url.split("/")[1..2]
  id ?= "Steve"
  size = Math.min(1024, Math.max(8, parseInt(size) || 8))
  renderFor(id, size)
    .then((buf) ->
      res.set("Content-Type", "image/png")
      res.status(200).send(buf))
    .catch((err) ->
      console.error(err)
      res.set("Content-Type", "text/plain")
      res.status(500).send("Internal Error - #{err}"))
