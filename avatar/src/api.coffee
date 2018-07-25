request = require("request-promise-cache")

# Render the avatars of a user given their uuid or username.
#
# @param {string} id - Uuid or username.
# @returns {promise<buffer>} - Image buffer of face and hat.
render = (id, size) ->
  profile(id).then((data) ->
    skin = data.textures.skin
    if typeof skin == "string" # Legacy api.
      binary(skin)
    else # v1 api.
      Promise.resolve(Buffer.from(skin = skin.data, "base64"))
    ).then((buf) ->
      avatar(buf, size))

# TODO: Change api url to "https://api.ashcon.app/mojang/v1/user/:id".
# Fetch the user profile from a uuid or username.
#
# @param {string} id - Uuid or username.
# @returns {promise<json>} - User profile as json.
profile = (id) ->
  request(uri: "https://api.ashcon.app/minecraft/user/#{id}", json: true, transform2xxOnly: true, cacheTTL: 300)

# TODO: Remove after v1 api transition.
# Fetch and download binary data as a buffer.
#
# @param {string} url - Url of the binary file to fetch.
# @returns {promise<buffer>} - Binary file as a buffer.
binary = (url) ->
  request(uri: url, encoding: null, transform2xxOnly: true, cacheTTL: 300)
    # BUG: Cached requests do not return buffer, but an object containing it.
    .then((buf) -> if Buffer.isBuffer(buf) then buf else Buffer.from(buf.data))

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
