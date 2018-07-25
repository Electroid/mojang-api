import "./util"
import { notFound } from "./http"
import { uuid, user, avatar } from "./api"

addEventListener("fetch", (event) ->
  event.respondWith(route(event.request)))

route = (request) ->
  [base, version, method, id, extra] = request.url.split("/")[3..7]
  if base == "mojang" && id?
    if version == "v1"
      v1(method, id, extra)
    else
      notFound("unknown api version '#{version}'")
  else
    notFound("unknown route")

v1 = (method, id, extra) ->
  if method == "uuid"
    [err, res] = await uuid(id)
  else if method == "user"
    [err, res] = await user(id)
  else if method == "avatar"
    res = avatar(id, extra)
  err || res || notFound("unknown v1 route '#{method}'")
