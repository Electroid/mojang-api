util = require("./util")
http = require("./http")

# Check the health of various Mojang services.
#
# @example
# [
#   {"minecraft.net": "green"},
#   {"api.mojang.com": "yellow"},
#   {"textures.minecraft.net": "red"}
# ]
#
# @throws {non-200} - When status servers are down, which should not happen.
# @returns {integer|json} - HTTP status code and array of service statuses.
health = ->
  http.get("https://status.mojang.com/check", ttl: 0) # No caching

# Get the UUID of a username at a given point in time.
#
# @example
# {
#   "id": "dad8b95ccf6a44df982e8c8dd70201e0",
#   "name": "ElectroidFilms"
# }
#
# @param {string} username - Minecraft username.
# @param {integer} secs - Unix seconds to set the context to.
# @throws {204} - When no user exists with that name.
# @throws {400} - When timestamp is invalid.
# @returns {integer|json} - HTTP status code and JSON response with UUID.
usernameToUuid = (username, secs = -1) ->
  time = if secs >= 0 then "?at=#{secs}" else ""
  http.get("https://api.mojang.com/users/profiles/minecraft/#{username}#{time}")

# Get the UUIDs of multiple usernames at the current time.
#
# @example
# [
#   {
#     "id": "dad8b95ccf6a44df982e8c8dd70201e0",
#     "name": "ElectroidFilms",
#     "legacy": false,
#     "demo": false
#   }
# ]
#
# @param {array<string>} usernames - Maximum of 100 usernames to query.
# @throws {400} - When given an empty or null username.
# @returns {integer|json} - HTTP status code and JSON response with UUIDs.
usernameToUuidBulk = (usernames...) ->
  http.post("https://api.mojang.com/profiles/minecraft", usernames)

# Get the history of usernames for the given UUID.
#
# @example
# [
#   {
#     "name": "ElectroidFilms"
#   },
#   {
#     "name": "Electric",
#     "changedToAt": 1423059891000
#   }
# ]
#
# @param {string} uuid - The UUID to check the username history for.
# @returns {integer|json} - HTTP status code and JSON of username history.
uuidToUsernameHistory = (uuid) ->
  http.get("https://api.mojang.com/user/profiles/#{uuid}/names")

# Get the session profile of the UUID.
#
# @example
# {
#   "id": "dad8b95ccf6a44df982e8c8dd70201e0",
#   "name": "ElectroidFilms",
#   "properties": [
#     {"name": "textures", "value": "...base64"}
#   ],
#   // Not in the upstream API, but added for convience.
#   "textures": {
#     "SKIN": {...},
#     "CAPE": {...},
#   }
# }
#
# @param {string} uuid - The UUID to get the session profile of.
# @returns {integer|json} - HTTP status code and JSON of session profile.
uuidToProfile = (uuid) ->
  [err, profile] = await http.get("https://sessionserver.mojang.com/session/minecraft/profile/#{uuid}")
  unless err
    # Decode the base64 string into an embeded json value,
    # but preserve the previous value for backwards-compatibility.
    if (textures = JSON.parse(atob(profile.properties[0].value)).textures).isEmpty()
      # If no textures are provided, default to either Steve or
      # Alex based on the oddity of the UUID.
      if uuidIsSlim(uuid)
        textures =
          SKIN: "http://textures.minecraft.net/texture/83cee5ca6afcdb171285aa00e8049c297b2dbeba0efb8ff970a5677a1b644032"
          metadata:
            model: "slim"
      else
        textures =
          SKIN: "http://textures.minecraft.net/texture/dc1c77ce8e54925ab58125446ec53b0cdd3d0ca3db273eb908d5482787ef4016"
    profile.textures = textures
  [err, profile]

# Determine if a UUID without custom textures inherits a slim skin model.
#
# @param {uuid} - The UUID to check if by default it comes with a slim model.
# @returns {boolean} - Whether the UUID by default comes with a slim model.
uuidIsSlim = (uuid) ->
  # Take every fourth byte of the UUID and determine
  # whether the sum is even (original) or odd (slim).
  sum = uuid.toInt(7) ^ uuid.toInt(15) ^ uuid.toInt(23) ^ uuid.toInt(31)
  sum % 2 != 0

module.exports = {
  health
  usernameToUuid
  usernameToUuidBulk
  uuidToProfile
  uuidToUsernameHistory
  uuidIsSlim
}
