import "browserify-zlib"
import { PNG } from "pngjs"
import XML from "xmlbuilder"

# Convert a Png to a Svg representation. 
#
# @param {string|buffer} data - Png buffer or base64 representation.
# @param {array<object>} regions - Select which regions from the Png to export.
# @param {object} view - Width and height of the viewbox.
# @param {boolean} snap - Whether to snap all regions to the origin (0, 0).
# @returns {string} - A Xml representation of the Svg.
export pngToSvg = (data, {regions, view, snap} = {}) ->
  if typeof data == "string"
    data = Buffer.from(data, "base64")
  if !view
    view = {width: img.width, height: img.height}
  if !regions || regions.length == 0
    regions = [{x: 0, y: 0, width: img.width, height: img.height}]
  img = PNG.sync.read(data)
  svg = XML.create("svg")
    .att("xmlns", "http://www.w3.org/2000/svg")
    .att("viewBox", "0 0 #{view.width} #{view.height}")
    .att("shape-rendering", "crispEdges")
  r = 0
  while r < regions.length
    region = regions[r]
    x = region.x
    while x < region.x + region.width
      y = region.y
      while y < region.y + region.height
        i = (img.width * y + x) << 2
        xAdj = x
        yAdj = y
        if snap
          xAdj -= region.x
          yAdj -= region.y
        svg.ele('rect',
          x: xAdj
          y: yAdj,
          width: 1,
          height: 1,
          fill: "rgba(#{img.data[i..i+3].join(",")})")
        y++
      x++
    r++
  svg.end(pretty: true)
