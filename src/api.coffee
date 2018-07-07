import { ok, invalidRequest } from "./http"
import { usernameToUuid, uuidToProfile, uuidToUsernameHistory } from "./mojang"

# If given a username, find its UUID, otherwise
# ensure that the input is a valid UUID.
#
# @param {string} str - Either a username or UUID.
# @returns {[err, string]} - HTTP error or a valid UUID.
export uuid = (str) ->
  if id = str.asUuid()
    [null, id]
  else if username = str.asUsername()
    [err, response] = await usernameToUuid(username)
    [err, response?.id]
  else
    [invalidRequest("Malformed UUID or Username '#{str}'"), null]

# Return the omnibus profile of a user given their UUID.
#
# @param {string} id - UUID of the user.
# @param {[err, object]} - HTTP error or a user profile.
export user = (id) ->
  [err, profile] = await uuidToProfile(id)
  unless err
    [err, history] = await uuidToUsernameHistory(id)
    unless err
      return [null, ok
        uuid: id = profile.id
        uuid_dashed: id.asUuid(dashed: true)
        username: profile.name
        username_history: history.map (item) ->
          username: item.name
          changed_at: item.changedToAt?.asDate()
        textures:
          skin: profile.textures.SKIN?.url
          cape: profile.textures.CAPE?.url
          slim: profile.textures.SKIN?.metadata?.model == "slim"
        cached_at: new Date()]
  return [err, null]
