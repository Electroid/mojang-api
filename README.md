# mojang-api
Javascript microservice that bundles multiple Mojang APIs into a single GET request.

### Purpose

Mojang, the developers of [Minecraft](https://en.wikipedia.org/wiki/Minecraft), provides [multiple APIs](http://wiki.vg/Mojang_API) for websites and servers to fetch identity information about users. Requests do not accept authentication tokens, however they are heavily rate limited and fragmented among several endpoints. The purpose of this project is to package several of the most commonly used APIs into a single GET request with no rate limiting and no need for client-side caching.

I have deployed this on my personal domain `ashcon.app` and am opening it up for the internet to use for free. It runs using [Cloudflare Workers](https://developers.cloudflare.com/workers/about/), which are Javascript functions that live in the closest datacenter to your request. The API is currently handling 1M+ requests per day with an average response time of 200ms and a < 0.0001% error rate.

### Single Request *(now)*

Username or UUID -> Everything<br>
[https://api.ashcon.app/mojang/v1/user/[username|uuid]](https://api.ashcon.app/mojang/v1/user/ElectroidFilms) `(click for example)`
```
{
  "uuid": <uuid>,
  "username": <username>,
  "username_history": [
    {
      "username": <username>,
      "changed_at": <date|null>
    }
  ],
  "textures": {
    "slim": <boolean>,
    "custom": <boolean>,
    "skin": {
      "url": <url>,
      "data": <base64>
    },
    "cape": {
      "url": <url|null>,
      "data": <base64|null>
    }
  },
  "cached_at": <date>
}
```

### Multiple Requests *(before)*

Username -> UUID<br>
[https://api.mojang.com/users/profiles/minecraft/[username]](https://api.mojang.com/users/profiles/minecraft/ElectroidFilms)
```
{
  "id": <uuid>,
  "name": <username>
}
```
UUID -> Username History<br>
[https://api.mojang.com/user/profiles/[uuid]/names](https://api.mojang.com/user/profiles/dad8b95ccf6a44df982e8c8dd70201e0/names)
```
[
  {
    "name": <username>
  },
  {
    "name": <username>,
    "changedToAt": <integer>
  }
]
```
UUID -> Profile + Textures<br>
[https://sessionserver.mojang.com/session/minecraft/profile/[uuid]](https://sessionserver.mojang.com/session/minecraft/profile/dad8b95ccf6a44df982e8c8dd70201e0)
```
{
  "id": <uuid>,
  "name": <username>,
  "properties": [
    {
      "name": "textures",
      "value": <base64> // Then decode the base64 string and make http requests to fetch the textures...
    }
  ]
}
```

### Build

```
npm i
npm run build
npm run preview -- \
  --preview-url https://localhost/mojang/v1/user/Notch
```
