util = require("./util")
http = require("./http")
mojang = require("./mojang")

# If given a username, find its UUID, otherwise
# ensure that the input is a valid UUID.
#
# @param {string} id - Either a username or UUID.
# @returns {[err, string]} - HTTP error or a valid UUID.
uuid = (id) ->
  if uuid = id.asUuid()
    [null, uuid]
  else if username = id.asUsername()
    [err, response] = await mojang.usernameToUuid(username)
    [err, response?.id]
  else
    [http.invalidRequest("Malformed UUID or Username '#{id}'"), null]

# Return the omnibus profile of a user given their UUID.
#
# @param {string} uuid - UUID of the user.
# @param {[err, object]} - HTTP error or a user profile.
user = (uuid) ->
  [err, profile] = await mojang.uuidToProfile(uuid)
  unless err
    [err, history] = await mojang.uuidToUsernameHistory(uuid)
    unless err
      return [null, http.ok
        uuid: uuid = profile.id
        uuid_dashed: uuid.asUuid(dashed: true)
        username: username = profile.name
        username_lower: username.toLowerCase()
        username_history: history.map (item) ->
          username: item.name
          changed_at: item.changedToAt?.asDate()
        textures:
          skin: profile.textures.SKIN?.url
          cape: profile.textures.CAPE?.url
          slim: profile.textures.SKIN?.metadata?.model == "slim"
        cached_at: new Date()]
  return [err, null]

module.exports = {
  uuid
  user
}
