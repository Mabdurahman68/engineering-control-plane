# Contract

`GET /items/:id` returns 200 and the item, or 404 and `{"error":"not_found"}`. An id with characters other than letters and digits returns 400 and `{"error":"bad_id"}`. `GET /items` is unchanged.
