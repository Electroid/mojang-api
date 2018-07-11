import { post } from "./http"

# Get a rendered avatar PNG of a given size from a textures URL.
#
# @example
# {
#   "texture": "292009a4925b58f02c77dadc3ecef07ea4c7472f64e0fdc32ce5522489362680",
#   "size": 128 // pixels
# }
#
# @param {string} textures - The texture ID provided from the mojang profile.
# @throws {404} - When texture ID could not be read.
# @throws {500} - When any other exception occurs.
# @returns {response} - Raw response from the PNG cloud function.
export urlToPng = (texture, size) ->
  return post("https://us-central1-stratus-197318.cloudfunctions.net/avatar", {texture: texture, size: size}, {raw: true, ttl: 86400})
