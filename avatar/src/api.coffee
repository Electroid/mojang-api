request = require("request-promise-cache")

# Fetch the user profile from a UUID or username.
#
# @param {string} id - UUID or username.
# @returns {promise<object>} - User profile as JSON.
profile = (id) ->
  request(uri: "https://ashcon.app/minecraft/user/#{id}", json: true, cacheKey: "profile/#{id}", cacheTTL: 86400)

# Fetch and download as a buffer the skin texture artifact.
#
# @param {object} profile - User profile.
# @param {promise<buffer>} - Image buffer.
texture = (data) ->
  request(uri: data.textures.skin, encoding: null, cacheKey: "texture/#{data.uuid}", cacheTTL: 86400)
    # BUG: Cached requests do not return Buffer, but an object containing it
    .then((buf) -> if Buffer.isBuffer(buf) then buf else Buffer.from(buf.data))
