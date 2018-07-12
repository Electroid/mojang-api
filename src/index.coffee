import "./util"
import { notFound } from "./http"
import { uuid, user, avatar } from "./api"

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
        # Off-load to legacy services until production ready
        url = new URL("https://avatar.ashcon.app/#{id.asUuid(dashed: true)}/256@2x.png")
        res = fetch(url, {cf: {resolveOverride: url.hostname}})
  err || res || notFound("Unknown Route")
