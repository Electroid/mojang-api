import { get, respond, error, notFound, badRequest } from "./http"
import { usernameToUuid, uuidToProfile, uuidToUsernameHistory, uuidIsSlim, textureAlex, textureSteve } from "./mojang"

# Get the uuid of a user given their username.
#
# @param {string} name - Minecraft username, must be alphanumeric 16 characters.
# @returns {[err, response]} - An error or the dashed uuid of the user.
export uuid = (name) ->
  if name.asUsername()
    [err, res] = await usernameToUuid(name)
    if id = res?.id?.asUuid(dashed: true)
      [null, respond(id, text: true)]
    else
      [err || notFound(), null]
  else
    [badRequest("malformed username '#{name}'"), null]

# Get the full profile of a user given their uuid or username.
#
# @param {string} id - Minecraft username or uuid.
# @returns {[err, json]} - An error or user profile.
export user = (id) ->
  if id.asUsername()
    [err, res] = await uuid(id)
    if err
      [err, null]
    else # Recurse with the new UUID.
      await user(id = await res.text())
  else if id.asUuid()
    [[err0, profile], [err1, history]] = await Promise.all([
      uuidToProfile(id = id.asUuid())
      uuidToUsernameHistory(id)])
    [err2, texture] = await textures(profile)
    if err = err0 || err1 || err2
      [err, null]
    else
      [null, respond(
        uuid: profile.id.asUuid(dashed: true)
        username: profile.name
        username_history: history.map((item) ->
          username: item.name
          changed_at: item.changedToAt?.asDate())
        textures: texture
        cached_at: new Date(),
      json: true)]
  else
    [badRequest("malformed uuid '#{id}'"), null]

# Parse and decode base64 textures from the user profile.
#
# @param {json} profile - User profile from #uuidToProfile(id).
# @returns {json} - Enhanced user profile with more convient texture fields.
textures = (profile) ->
  unless profile
    return [error("no user profile found"), null]
  properties = profile.properties
  if properties.length == 1
    texture = properties[0]
  else
    texture = properties.filter((pair) -> pair.name == "textures" && pair.value?)[0]
  if !texture || (texture = JSON.parse(atob(texture.value)).textures).isEmpty()
    [type, skin] = if uuidIsSlim(profile.id) then ["alex", textureAlex] else ["steve", textureSteve]
    skinUrl = "http://assets.mojang.com/SkinTemplates/#{type}.png"
  else
    [skin, cape] = await Promise.all([
      get(skinUrl = texture.SKIN?.url, base64: true, ttl: 86400)
      get(capeUrl = texture.CAPE?.url, base64: true, ttl: 86400)])
  unless skin
    [error("unable to fetch skin '#{skinUrl}'"), null]
  else
    texture =
      custom: !type?
      slim: texture.SKIN?.metadata?.model == "slim" || type == "alex"
      skin: {url: skinUrl, data: skin}
      cape: {url: capeUrl, data: cape} if capeUrl
    [null, texture]

# Redirect to the avatar service to render the face of a user.
#
# @param {string} id - Uuid of the user.
# @param {integer} size - Size in pixels of the avatar.
# @returns {promise<response>} - Avatar response as a png.
export avatar = (id = "Steve", size = 8) ->
  get("https://avatar.ashcon.app/#{id}/#{size}")
