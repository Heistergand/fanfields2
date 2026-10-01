# GeoIP region table

`ipv4-regions.bin` is a precomputed, sorted table of IPv4 ranges used by `server.js` to turn a
client IP into one of the 8 region buckets (`other`, `north_america`, `south_america`,
`west_europe`, `middle_east_africa`, `east_europe`, `china`, `asia`) via binary search. It is
built offline and committed as a binary asset — the server never fetches or parses anything at
runtime beyond reading this file.

## Format

Flat array of 5-byte records, sorted by `start`:

```
uint32 start   (big-endian, inclusive start of an IPv4 range, as a plain integer)
uint8  regionId (index into the REGIONS array in server.js)
```

A range ends where the next one begins (or at 255.255.255.255 for the last record). Looking up
an IP finds the last record whose `start` is <= the IP's integer value.

## Regenerating

Source data: [GeoLite2 country, IPv4, numeric CSV](https://github.com/sapics/ip-location-db)
(`geolite2-country-ipv4-num.csv`, CC-BY-SA / GeoLite2 license, attribution: MaxMind):

```sh
curl -LO https://github.com/sapics/ip-location-db/releases/download/latest/geolite2-country-ipv4-num.csv
node build.js
```

`build.js` converts the ~190 country codes to the 8 region buckets and merges consecutive
same-region ranges — the merge is what shrinks ~357k source rows down to the ~192k actually
stored here. Re-run occasionally to pick up IP block reassignments; not security-critical, so
there's no automation for it.

IPv6 isn't covered (no table shipped for it): an IPv6 client always resolves to `other`.
