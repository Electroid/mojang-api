util = require("./util")
http = require("./http")
mojang = require("./mojang")

uuid = (id) ->
  if uuid = id.asUuid()
    [null, uuid]
  else if username = id.asUsername()
    [err, response] = await mojang.usernameToUuid(username)
    [err, response.id unless err]
  else
    [http.invalidRequest(idOrName), null]

user = (uuid) ->
  [err, profile] = await mojang.uuidToProfile(uuid)
  unless err
    [err, history] = await mojang.uuidToUsernameHistory(uuid)
    unless err
      console.log(profile)
      console.log(history)
      return http.ok
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
        cached_at: new Date()
  return err

module.exports = {
  uuid
  user
}
