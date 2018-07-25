request = require("request-promise-cache")

# Render the avatars of a user given their uuid or username.
#
# @param {string} id - Uuid or username.
# @returns {promise<buffer>} - Image buffer of face and hat.
render = (id, size) ->
  profile(id).then((data) ->
    Buffer.from(data.textures.skin.data, "base64")).then((buf) ->
      avatar(buf, size))

# Fetch the user profile from a uuid or username.
#
# @param {string} id - Uuid or username.
# @returns {promise<json>} - User profile as json.
profile = (id) ->
  request(uri: "https://api.ashcon.app/mojang/v1/user/#{id}", json: true, transform2xxOnly: true, cacheTTL: 300)

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
