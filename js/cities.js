/**
 * cities.js
 * A small built-in gazetteer of European cities so the map can plot routes
 * without a network geocoding service. When a user types a known city name,
 * its coordinates are auto-filled. Unknown names fall back to manual lat/lng
 * (or a default European centroid).
 *
 * Exposed globally as window.CITIES (name -> {lat, lng}).
 */
(function () {
  const CITIES = {
    'London': { lat: 51.5074, lng: -0.1278 },
    'Paris': { lat: 48.8566, lng: 2.3522 },
    'Amsterdam': { lat: 52.3676, lng: 4.9041 },
    'Brussels': { lat: 50.8503, lng: 4.3517 },
    'Berlin': { lat: 52.52, lng: 13.405 },
    'Munich': { lat: 48.1351, lng: 11.582 },
    'Frankfurt': { lat: 50.1109, lng: 8.6821 },
    'Cologne': { lat: 50.9375, lng: 6.9603 },
    'Hamburg': { lat: 53.5511, lng: 9.9937 },
    'Zurich': { lat: 47.3769, lng: 8.5417 },
    'Geneva': { lat: 46.2044, lng: 6.1432 },
    'Vienna': { lat: 48.2082, lng: 16.3738 },
    'Prague': { lat: 50.0755, lng: 14.4378 },
    'Budapest': { lat: 47.4979, lng: 19.0402 },
    'Madrid': { lat: 40.4168, lng: -3.7038 },
    'Barcelona': { lat: 41.3851, lng: 2.1734 },
    'Seville': { lat: 37.3891, lng: -5.9845 },
    'Valencia': { lat: 39.4699, lng: -0.3763 },
    'Lisbon': { lat: 38.7223, lng: -9.1393 },
    'Porto': { lat: 41.1579, lng: -8.6291 },
    'Rome': { lat: 41.9028, lng: 12.4964 },
    'Florence': { lat: 43.7696, lng: 11.2558 },
    'Venice': { lat: 45.4408, lng: 12.3155 },
    'Milan': { lat: 45.4642, lng: 9.19 },
    'Naples': { lat: 40.8518, lng: 14.2681 },
    'Athens': { lat: 37.9838, lng: 23.7275 },
    'Santorini': { lat: 36.3932, lng: 25.4615 },
    'Dublin': { lat: 53.3498, lng: -6.2603 },
    'Edinburgh': { lat: 55.9533, lng: -3.1883 },
    'Copenhagen': { lat: 55.6761, lng: 12.5683 },
    'Stockholm': { lat: 59.3293, lng: 18.0686 },
    'Oslo': { lat: 59.9139, lng: 10.7522 },
    'Helsinki': { lat: 60.1699, lng: 24.9384 },
    'Warsaw': { lat: 52.2297, lng: 21.0122 },
    'Krakow': { lat: 50.0647, lng: 19.945 },
    'Nice': { lat: 43.7102, lng: 7.262 },
    'Lyon': { lat: 45.764, lng: 4.8357 },
    'Marseille': { lat: 43.2965, lng: 5.3698 },
    'Bruges': { lat: 51.2093, lng: 3.2247 },
    'Salzburg': { lat: 47.8095, lng: 13.055 },
    'Interlaken': { lat: 46.6863, lng: 7.8632 },
    'Lucerne': { lat: 47.0502, lng: 8.3093 },
    'Granada': { lat: 37.1773, lng: -3.5986 },
    'Pisa': { lat: 43.7228, lng: 10.4017 },
    'Cinque Terre': { lat: 44.1461, lng: 9.6439 },
  };

  // Case-insensitive lookup helper.
  CITIES.lookup = function (name) {
    if (!name) return null;
    const key = Object.keys(CITIES).find(
      (k) => k.toLowerCase() === String(name).trim().toLowerCase()
    );
    return key ? { lat: CITIES[key].lat, lng: CITIES[key].lng } : null;
  };

  window.CITIES = CITIES;
})();
