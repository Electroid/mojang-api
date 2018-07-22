# Render the avatars of a user given their UUID or username.
#
# @param {string} id - UUID or username.
# @returns {promise<buffer>} - Image buffer of face and hat.
render = (id, size) ->
  profile(id).then((data) ->
    # TEMP: Backwards compatible between base64 and url.
    # Can be removed once api v0.2 is deployed.
    skin = data.textures.skin
    try
      url = new URL(skin)
      binary(data.textures.skin)
    catch e
      Promise.resolve(Buffer.from(skin, "base64"))
    ).then((buf) ->
      avatar(buf, size))

# Render the face and hat of a user.
#
# @param {buffer} buf - Image buffer of the raw skin texture.
# @param {integer} size - Size in pixels to transform the image.
# @returns {promise<buffer>} - Image buffer of face and hat.
avatar = (buf, size) ->
  Promise.all([
    crop(buf, 8, 8, 8, 8)
    crop(buf, 40, 8, 8, 8)])
  .then(([face, hat]) ->
    compose(face, hat))
  .then((both) ->
    resize(both, size))
