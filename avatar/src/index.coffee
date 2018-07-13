exports.get = (req, res) ->
  id = req.body.id
  size = resizeNearest(req.body.size)
  res.set("Content-Type", "image/png")
  exists(file = "#{id}/#{size}")
    .then((cached) ->
      if cached
        res.pipe(read(file))
      else
        fetchAndRender(req.body.id)
          .then(([id, bufs]) ->
            bufs.map(([i, buf]) ->
              if i == size
                res.status(200).send(buf)
              savePng(file = "#{id}/#{i}", buf)))
          .catch((err) ->
            console.error(err)
            res.status(500).end()))

# Render the avatars of a user given their UUID or username.
#
# @param {string} id - UUID or username.
# @returns {promise<[string, [integer, buffer]]>} - Dashed UUID and resized buffers.
fetchAndRender = (id) ->
  profile(id).then((data) ->
    id = data.uuid_dashed
    texture(data)).then((buf) ->
      render(buf).then((buf) ->
        [id, buf]))

# Render an avatar given the texture image of a user.
#
# @param {buffer} buf - Image buffer of textures.
# @returns {promise<[[integer, buffer]]>} - Size of image with new image buffer.
render = (buf) ->
  Promise.all([
    crop(buf, 8, 8, 8, 8)
    crop(buf, 40, 8, 8, 8)
  ]).then(([face, hat]) ->
    compose(face, hat))
    .then((both) ->
      resizeMulti(both))
