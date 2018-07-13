request = require("request-promise-native")

# Fetch the user profile from a UUID or username.
#
# @param {string} id - UUID or username.
# @returns {promise<object>} - User profile as JSON.
profile = (id = "Steve") ->
  request(uri: "https://ashcon.app/minecraft/user/#{id}", json: true)

# Fetch and download as a buffer the skin texture artifact.
#
# @param {object} profile - User profile.
# @param {promise<buffer>} - Image buffer.
texture = (data) ->
  request(uri: data.textures.skin, encoding: null)
