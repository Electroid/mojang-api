# Render the avatars of a user given their UUID or username.
#
# @param {string} id - UUID or username.
# @returns {promise<buffer>} - Image buffer of face and hat.
renderFor = (id, size) ->
  profile(id).then((data) ->
    id = data.uuid_dashed
    texture(data)).then((buf) ->
      render(buf, size))

# Render an avatar given the texture image of a user.
#
# @param {buffer} buf - Image buffer of textures.
# @param {integer} size - Size in pixels to transform the image.
# @returns {promise<buffer>} - Image buffer of face and hat.
render = (buf, size) ->
  Promise.all([
    crop(buf, 8, 8, 8, 8)
    crop(buf, 40, 8, 8, 8)
  ]).then(([face, hat]) -> compose(face, hat))
    .then((both) -> resize(both, size))
