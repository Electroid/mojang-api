/**
 * Wrapper for invoking Mojang's APIs.
 *
 * No authentication is required and responses must be
 * cached to prevent non-response errors. A full spec
 * of their api can be found here: http://wiki.vg/Mojang_API
 *
 * @author Ashcon Partovi
 * @date June 22nd 2018
 */

addEventListener('fetch', event =>
  event.respondWith(respondAll(event.request)))

/**
 * Ensure that the given input is a valid UUIDv4.
 *
 * Mojang endpoints expect UUIDs without dashes,
 * so this will also remove dashes.
 *
 * @param {string} uuid - A string that represents a UUID.
 * @throws {error} - If given input is not a valid UUID.
 * @returns {[string, string]} - An error string, the non-dashed UUID. 
 */
function validateUuid(uuid) {
  if(uuidUndashedRegex.test(uuid)) {
    return [null, uuid]
  } else if(uuidDashedRegex.test(uuid)) {
    return [null, uuid.substring(0, 8)
      + uuid.substring(9, 13)
      + uuid.substring(14, 18)
      + uuid.substring(19, 23)
      + uuid.substring(24, 36)]
  } else {
    return ['Invalid UUID format: ' + uuid, null]
  }
}

const uuidDashedRegex = /^[A-F\d]{8}-[A-F\d]{4}-4[A-F\d]{3}-[89AB][A-F\d]{3}-[A-F\d]{12}$/i
const uuidUndashedRegex = /^[A-F\d]{8}[A-F\d]{4}4[A-F\d]{3}[89AB][A-F\d]{3}[A-F\d]{12}$/i

/**
 * Determine whether the UUID has a "steve" or "alex"
 * skin. In Java, the implementation is as follows:
 * `uuid.hashCode() & 1`
 *
 * @param {string} - A non-dashed UUID.
 * @param {string} - The UUID of either "steve" or "alex."
 */
function defaultUuid(uuid) {
  // Take every fourth byte of the UUID
  // and determine whether the sum is
  // even (steve) or odd (alex).
  var sum = toInt(uuid, 7)
    ^ toInt(uuid, 15)
    ^ toInt(uuid, 23)
    ^ toInt(uuid, 31)
  return sum % 2 == 0 ? steveUuid : alexUuid
}

const steveUuid = '8667ba71b85a4004af54457a9734eed7'
const alexUuid = '6ab4317889fd490597f60f67d9d76fd9'

/**
 * Fetch the UUID associated with the given Minecraft username.
 *
 * Responses are cached for 1 hour, to prevent
 * a rate limit error from the Mojang API.
 *
 * @param {string} username - A valid Minecraft username.
 * @param {int} seconds - The unix seconds the query should assume.
 * @returns {promise<json>} - A promise with the body response.
 */
async function fetchUuid(username, seconds = null) {
  return request(uuidUrl + username + (seconds ? '?at=' + seconds : ''), 3600)
}

const uuidUrl = 'https://api.mojang.com/users/profiles/minecraft/'

/**
 * Fetch the history of Minecraft usernames associated with the given UUID.
 *
 * @param {string} - A non-dashed UUID.
 * @returns {promise<json>} - A promise with the body response.
 */
async function fetchUsernameHistory(uuid) {
  return request(usernameHistoryUrl + uuid + usernameHistorySuffix, 3600)
}

const usernameHistoryUrl = 'https://api.mojang.com/user/profiles/'
const usernameHistorySuffix = '/names'

/**
 * Fetch the session profile of the given UUID.
 *
 * Responses are cached for 1 minute, to prevent
 * a rate limit error from the Mojang API.
 *
 * @param {string} - A non-dashed UUID.
 * @returns {promise<json>} - A promise with the body response.
 */
async function fetchProfile(uuid) {
  return request(profileUrl + uuid, 60)
}

const profileUrl = 'https://sessionserver.mojang.com/session/minecraft/profile/'

/**
 * Extract and decode the texture hash from a session profile.
 *
 * @param {json} profile - A session profile.
 * @throws {error} - When textures cannot be parsed.
 * @returns {[string, string]} - An error, the decoded textures hash.
 */
function parseTextures(profile) {
  var textures = profile.properties.filter(p => p.name === 'textures')
  if(textures.length >= 1) {
    return [200, JSON.parse(atob(textures[0].value))]
  } else {
    return [500, null]
  }
}

/**
 * Send a HTTP GET request to the given URL with a cache time.
 *
 * @param {string} url - The endpoint to send the request.
 * @param {int} ttl - The seconds for Cloudflare to cache the request.
 * @returns {promise<json>} - The response from the endpoint.
 */
async function request(url, ttl) {
  let response = await fetch(url, {cf: {cacheTtl: ttl}})
  let status = response.status
  return [status, status == 200 ? await response.json() : null]
}

async function respondAll(request) {
  const url = request.url
  let uuidQuery = endpointUuidRegex.exec(url)
  if(uuidQuery) {
    return respondUuid(uuidQuery[1])
  }
  let usernameQuery = endpointUsernameRegex.exec(url)
  if(usernameQuery) {
    return respondUsername(usernameQuery[1], usernameQuery[2])
  }
  return respondErr('Unknown route', 404)
}

const endpointUsernameRegex = /.*\/minecraft\/username\/(.*)(?:\?at=(.*))?/
const endpointUuidRegex = /.*\/minecraft\/uuid\/(.*)/

async function respondUuid(uuid) {
  const [err, uuidv4] = validateUuid(uuid)
  if(err) {
    return respondErr(err)
  }
  const [c1, profile] = await fetchProfile(uuidv4)
  if(!profile) {
    return respondErr('Could not fetch session', c1)
  }
  const [c2, textures] = parseTextures(profile)
  if(!textures) {
    return respondErr('Could not parse textures', c2)
  }
  const [c3, history] = await fetchUsernameHistory(uuidv4)
  if(!profile) {
    return respondErr('Could not fetch name history', c3)
  }
  return respond({
    uuid: profile.id,
    name: profile.name,  
    name_history: history.map(item => ({
      name: item.name,
      changed_at: item.changedToAt ? new Date(item.changedToAt * 1000) : null
    })),
    skin_url: (textures.textures.SKIN || {}).url,
    cape_url: (textures.textures.CAPE || {}).url,
    cached_at: new Date(textures.timestamp * 1000)
  })
}

async function respondUsername(username, seconds) {
  const [code, res] = await fetchUuid(username, seconds)
  if(!res || !res.id) {
    return respondErr('Could not fetch uuid', code)
  }
  return respondUuid(res.id)
}

function respondErr(err = 'Internal error', code = 500) {
  return respond({status: code, message: err}, code)
}

function respond(json, code = 200) {
  return new Response(
    JSON.stringify(json),
    {status: code, headers: {'Content-Type': 'application/json'}}
  )
}

/**
 * An efficient method of converting
 * base 16 representations into base 10.
 *
 * Much faster than #parseInt(hex, 16).
 *
 * @param {string} hex - A hex string.
 * @param {int} i - The index of the string.
 * @returns {int} - The base 10 representation of the indexed hex.
 */
function toInt(hex, i = 0) {
  var c = hex.charCodeAt(i)
  if(c >= 97) { // a-f
    return c - 87
  } else { // 0-9
    return c - 48
  }
}

/*
TODO: Remove code to upload to Cloudflare
const nodeFetch = require('node-fetch')
const ttl = require('ttl')
const cache = new ttl({
  ttl: 60,
  capacity: 10
})
function fetch(url, options) {
  result = cache.get(url)
  if(!result) {
    result = nodeFetch(url, options)
    cache.put(url, result)
  }
  return result
}
module.exports = {
  validateUuid: validateUuid,
  defaultUuid: defaultUuid,
  steveUuid: steveUuid,
  alexUuid: alexUuid,
  fetchUuid: fetchUuid,
  fetchUsernameHistory: fetchUsernameHistory,
  fetchProfile: fetchProfile,
  parseTextures: parseTextures,
  request: request,
  toInt: toInt
}
*/
