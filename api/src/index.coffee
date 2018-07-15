import "./util"
import { notFound, get } from "./http"
import { uuid, user } from "./api"

addEventListener("fetch", (event) ->
  event.respondWith(route(event.request)))

route = (request) ->
  [base, method, id, extra] = request.url.split("/")[3..6]
  if base == "minecraft" && id?
    [err, id] = await uuid(id)
    unless err
      if method == "user"
        [err, res] = await user(id)
      else if method == "avatar"
        res = get("https://us-central1-stratus-197318.cloudfunctions.net/avatar/#{id}/#{extra}", ttl: 86400)
  err || res || notFound("Unknown Route")
