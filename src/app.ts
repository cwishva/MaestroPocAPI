import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";
import { check, validationResult } from "express-validator";

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Amadeus and Seats.aero API configuration
const AMADEUS_API = process.env.AMADEUS_API || "https://test.api.amadeus.com";
const SEATS_AERO_API = "https://seats.aero/partnerapi";
let amadeusToken = "";
const CAD_TO_USD = 0.72;

// Validate date format (YYYY-MM-DD)
function validateDate(dateStr) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateStr.match(regex)) return false;
  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date);
}

// Get Amadeus token
async function getAmadeusToken() {
  try {
    const response = await axios.post(
      `${AMADEUS_API}/v1/security/oauth2/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AMADEUS_CLIENT_ID || "",
        client_secret: process.env.AMADEUS_CLIENT_SECRET || "",
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    amadeusToken = response.data.access_token;
    setTimeout(() => (amadeusToken = ""), response.data.expires_in * 1000);
    return amadeusToken;
  } catch (error) {
    console.error("Amadeus token error:", error.message);
    throw new Error("Failed to get Amadeus token");
  }
}

// Fetch Seats.aero data for both outbound and return flights
async function getSeatsAeroFlights(
  origin,
  destination,
  date,
  cabin,
  nonstop,
  returnDate = null
) {
  try {
    const cabinMap = {
      economy: {
        available: "YAvailable",
        cost: "YMileageCostRaw",
        taxes: "YTotalTaxesRaw",
        direct: "YDirect",
        airline: "YAirlines",
      },
      business: {
        available: "JAvailable",
        cost: "JMileageCostRaw",
        taxes: "JTotalTaxesRaw",
        direct: "JDirect",
        airline: "JAirlines",
      },
    };

    const cabinFields = cabinMap[cabin] || cabinMap.economy;

    // Fetch outbound flights
    const outboundResponse = await axios.get(`${SEATS_AERO_API}/availability`, {
      params: {
        origin_airport: origin,
        destination_airport: destination,
        start_date: date,
        end_date: date,
        take: 15,
        order_by: "YMileageCostRaw",
      },
      headers: {
        "Partner-Authorization": process.env.SEATS_AERO_API_KEY || "",
      },
    });

    // console.log(
    //   `Seats.aero outbound response for ${origin}-${destination} on ${date}:`,
    //   JSON.stringify(outboundResponse.data, null, 2)
    // );

    const outboundFlights = outboundResponse.data.data
      .filter(
        (flight) =>
          flight[cabinFields.available] &&
          (!nonstop || flight[cabinFields.direct]) &&
          !flight[cabinFields.airline].includes(",")
      )
      .map((flight) => {
        const taxes_fees = flight[cabinFields.taxes] * CAD_TO_USD;
        return {
          airline: flight[cabinFields.airline],
          points: flight[cabinFields.cost],
          taxes_fees,
          direct: flight[cabinFields.direct],
          origin: flight.Route.OriginAirport,
          destination: flight.Route.DestinationAirport,
          departure_date: flight.Date,
          cabin: cabin,
          seats_available:
            flight[
              `${cabinFields.available.replace(
                "Available",
                "RemainingSeatsRaw"
              )}`
            ] || 1,
          program: flight.Source,
        };
      });

    // Fetch return flights if returnDate is provided
    let returnFlights = [];
    if (returnDate) {
      const returnResponse = await axios.get(`${SEATS_AERO_API}/availability`, {
        params: {
          origin_airport: destination,
          destination_airport: origin,
          start_date: returnDate,
          end_date: returnDate,
          take: 15,
          order_by: "YMileageCostRaw",
        },
        headers: {
          "Partner-Authorization": process.env.SEATS_AERO_API_KEY || "",
        },
      });

      // console.log(
      //   `Seats.aero return response for ${destination}-${origin} on ${returnDate}:`,
      //   JSON.stringify(returnResponse.data, null, 2)
      // );

      returnFlights = returnResponse.data.data
        .filter(
          (flight) =>
            flight[cabinFields.available] &&
            (!nonstop || flight[cabinFields.direct]) &&
            !flight[cabinFields.airline].includes(",")
        )
        .map((flight) => {
          const taxes_fees = flight[cabinFields.taxes] * CAD_TO_USD;
          return {
            airline: flight[cabinFields.airline],
            points: flight[cabinFields.cost],
            taxes_fees,
            direct: flight[cabinFields.direct],
            origin: flight.Route.OriginAirport,
            destination: flight.Route.DestinationAirport,
            departure_date: flight.Date,
            cabin: cabin,
            seats_available:
              flight[
                `${cabinFields.available.replace(
                  "Available",
                  "RemainingSeatsRaw"
                )}`
              ] || 1,
            program: flight.Source,
          };
        });
    }

    return { outboundFlights, returnFlights };
  } catch (error) {
    console.error(
      `Seats.aero error for ${origin}-${destination}:`,
      error.message
    );
    return { outboundFlights: [], returnFlights: [] };
  }
}

// Fetch cash flights from Amadeus with fallback
async function fetchCashFlights(token, params) {
  try {
    let flights = [];
    let attempts = [{ nonstop: params.nonstop }, { nonstop: false }]; // Try nonstop first, then any flights

    for (const attempt of attempts) {
      try {
        const response = await axios.get(
          `${AMADEUS_API}/v2/shopping/flight-offers`,
          {
            params: {
              originLocationCode: params.origin,
              destinationLocationCode: params.destination,
              departureDate: params.departureDate,
              adults: params.adults,
              children: params.children,
              travelClass: params.travelClass,
              nonStop: attempt.nonstop,
              ...(params.tripType === "round" && params.returnDate
                ? { returnDate: params.returnDate }
                : {}),
              max: 10,
            },
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        console.log(
          `Amadeus response for ${params.origin}-${params.destination}:`,
          response.data.data.length
        );

        flights = response.data.data.map((flight) => ({
          airline: flight.itineraries[0].segments[0].carrierCode,
          cash_price: parseFloat(flight.price.total),
          nonstop: flight.itineraries[0].segments.length === 1,
          departure_time: flight.itineraries[0].segments[0].departure.at
            .split("T")[1]
            .slice(0, 5),
          arrival_time: flight.itineraries[0].segments[0].arrival.at
            .split("T")[1]
            .slice(0, 5),
          departure_date:
            flight.itineraries[0].segments[0].departure.at.split("T")[0],
          return_departure_time:
            params.tripType === "round" && flight.itineraries[1]
              ? flight.itineraries[1].segments[0].departure.at
                  .split("T")[1]
                  .slice(0, 5)
              : null,
          return_arrival_time:
            params.tripType === "round" && flight.itineraries[1]
              ? flight.itineraries[1].segments[0].arrival.at
                  .split("T")[1]
                  .slice(0, 5)
              : null,
          return_date:
            params.tripType === "round" && flight.itineraries[1]
              ? flight.itineraries[1].segments[0].departure.at.split("T")[0]
              : null,
        }));

        if (flights.length) break;
      } catch (error) {
        console.error(
          `Amadeus error for ${params.origin}-${params.destination}:`,
          error.message
        );
      }
    }

    // Fallback to separate one-way queries for round trips
    if (!flights.length && params.tripType === "round" && params.returnDate) {
      const outboundFlights = [];
      const returnFlights = [];
      for (const attempt of attempts) {
        // Outbound leg
        try {
          const outboundResponse = await axios.get(
            `${AMADEUS_API}/v2/shopping/flight-offers`,
            {
              params: {
                originLocationCode: params.origin,
                destinationLocationCode: params.destination,
                departureDate: params.departureDate,
                adults: params.adults,
                children: params.children,
                travelClass: params.travelClass,
                nonStop: attempt.nonstop,
                max: 10,
              },
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          outboundFlights.push(
            ...outboundResponse.data.data.map((flight) => ({
              airline: flight.itineraries[0].segments[0].carrierCode,
              cash_price: parseFloat(flight.price.total),
              nonstop: flight.itineraries[0].segments.length === 1,
              departure_time: flight.itineraries[0].segments[0].departure.at
                .split("T")[1]
                .slice(0, 5),
              arrival_time: flight.itineraries[0].segments[0].arrival.at
                .split("T")[1]
                .slice(0, 5),
              departure_date:
                flight.itineraries[0].segments[0].departure.at.split("T")[0],
              return_departure_time: null,
              return_arrival_time: null,
              return_date: null,
            }))
          );
        } catch (error) {
          console.error(
            `Amadeus outbound error for ${params.origin}-${params.destination}:`,
            error.message
          );
        }

        // Return leg
        try {
          const returnResponse = await axios.get(
            `${AMADEUS_API}/v2/shopping/flight-offers`,
            {
              params: {
                originLocationCode: params.destination,
                destinationLocationCode: params.origin,
                departureDate: params.returnDate,
                adults: params.adults,
                children: params.children,
                travelClass: params.travelClass,
                nonStop: attempt.nonstop,
                max: 10,
              },
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          returnFlights.push(
            ...returnResponse.data.data.map((flight) => ({
              airline: flight.itineraries[0].segments[0].carrierCode,
              cash_price: parseFloat(flight.price.total),
              nonstop: flight.itineraries[0].segments.length === 1,
              departure_time: flight.itineraries[0].segments[0].departure.at
                .split("T")[1]
                .slice(0, 5),
              arrival_time: flight.itineraries[0].segments[0].arrival.at
                .split("T")[1]
                .slice(0, 5),
              departure_date:
                flight.itineraries[0].segments[0].departure.at.split("T")[0],
            }))
          );
        } catch (error) {
          console.error(
            `Amadeus return error for ${params.destination}-${params.origin}:`,
            error.message
          );
        }

        if (outboundFlights.length && returnFlights.length) break;
      }

      // Combine outbound and return flights
      if (outboundFlights.length && returnFlights.length) {
        for (const outbound of outboundFlights) {
          for (const ret of returnFlights) {
            if (outbound.airline === ret.airline) {
              flights.push({
                airline: outbound.airline,
                cash_price: outbound.cash_price + ret.cash_price,
                nonstop: outbound.nonstop && ret.nonstop,
                departure_time: outbound.departure_time,
                arrival_time: outbound.arrival_time,
                departure_date: outbound.departure_date,
                return_departure_time: ret.departure_time,
                return_arrival_time: ret.arrival_time,
                return_date: ret.departure_date,
              });
            }
          }
        }
      }
    }

    return flights;
  } catch (error) {
    console.error(
      `Amadeus cash flights error for ${params.origin}-${params.destination}:`,
      error.message
    );
    return [];
  }
}

// Middleware to ensure Amadeus token
async function ensureAmadeusToken(req, res, next) {
  if (!amadeusToken) {
    try {
      await getAmadeusToken();
    } catch (error) {
      return res.status(500).json({
        error: "Failed to authenticate with Amadeus",
        details: error.message,
      });
    }
  }
  req.amadeusToken = amadeusToken;
  next();
}

// Input validation for flight queries
const validateFlightQuery = [
  check("origin")
    .isLength({ min: 3, max: 3 })
    .withMessage("Origin must be a 3-letter IATA code"),
  check("destination")
    .isLength({ min: 3, max: 3 })
    .withMessage("Destination must be a 3-letter IATA code"),
  check("departureDate")
    .custom((value) => validateDate(value))
    .withMessage("Invalid departureDate format (YYYY-MM-DD)"),
  check("returnDate")
    .optional()
    .custom((value) => validateDate(value))
    .withMessage("Invalid returnDate format (YYYY-MM-DD)"),
  check("adults")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Adults must be a positive integer"),
  check("children")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Children must be a non-negative integer"),
  check("tripType")
    .optional()
    .isIn(["one-way", "round"])
    .withMessage("Trip type must be one-way or round"),
  check("nonstop")
    .optional()
    .isBoolean()
    .withMessage("Nonstop must be a boolean"),
];

// GET /flights/economy
app.get(
  "/flights/economy",
  ensureAmadeusToken,
  validateFlightQuery,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        origin,
        destination,
        departureDate,
        returnDate,
        adults = 1,
        children = 0,
        tripType = "one-way",
        nonstop = false,
      } = req.query;

      if (tripType === "round" && !returnDate) {
        return res
          .status(400)
          .json({ error: "Missing returnDate for round trip" });
      }

      const cashFlights = await fetchCashFlights(req.amadeusToken, {
        origin,
        destination,
        departureDate,
        returnDate,
        adults: parseInt(adults),
        children: parseInt(children),
        travelClass: "ECONOMY",
        nonstop,
        tripType,
      });

      const { outboundFlights } = await getSeatsAeroFlights(
        origin,
        destination,
        departureDate,
        "economy",
        nonstop,
        tripType === "round" ? returnDate : null
      );

      const flights = outboundFlights
        .map((award) => {
          const cashFlight = cashFlights.find(
            (cf) =>
              cf.airline === award.airline &&
              cf.departure_date === award.departure_date &&
              cf.nonstop === award.direct
          ) || {
            cash_price: null,
            departure_time: "N/A",
            arrival_time: "N/A",
            return_departure_time: null,
            return_arrival_time: null,
          };
          const taxes_fees = cashFlight.cash_price
            ? Math.min(award.taxes_fees, cashFlight.cash_price * 0.1)
            : award.taxes_fees;
          return {
            ...award,
            cash_price: cashFlight.cash_price || award.taxes_fees / 0.1,
            taxes_fees,
            departure_time: cashFlight.departure_time,
            arrival_time: cashFlight.arrival_time,
            return_departure_time: cashFlight.return_departure_time,
            return_arrival_time: cashFlight.return_arrival_time,
            return_date: cashFlight.return_date || returnDate,
            cpp:
              award.points && cashFlight.cash_price
                ? Math.max(
                    0,
                    ((cashFlight.cash_price - taxes_fees) /
                      ((parseInt(adults) + parseInt(children)) *
                        award.points)) *
                      100
                  )
                : 0,
          };
        })
        .filter((flight) => flight.cash_price);

      res.json(flights);
    } catch (error) {
      console.error("Economy flights error:", error.message);
      res.status(500).json({
        error: "Failed to fetch economy flights",
        details: error.message,
      });
    }
  }
);

// GET /flights/business
app.get(
  "/flights/business",
  ensureAmadeusToken,
  validateFlightQuery,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        origin,
        destination,
        departureDate,
        returnDate,
        adults = 1,
        children = 0,
        tripType = "one-way",
        nonstop = false,
      } = req.query;

      if (tripType === "round" && !returnDate) {
        return res
          .status(400)
          .json({ error: "Missing returnDate for round trip" });
      }

      const cashFlights = await fetchCashFlights(req.amadeusToken, {
        origin,
        destination,
        departureDate,
        returnDate,
        adults: parseInt(adults),
        children: parseInt(children),
        travelClass: "BUSINESS",
        nonstop,
        tripType,
      });

      const { outboundFlights } = await getSeatsAeroFlights(
        origin,
        destination,
        departureDate,
        "business",
        nonstop,
        tripType === "round" ? returnDate : null
      );

      const flights = outboundFlights
        .map((award) => {
          const cashFlight = cashFlights.find(
            (cf) =>
              cf.airline === award.airline &&
              cf.departure_date === award.departure_date &&
              cf.nonstop === award.direct
          ) || {
            cash_price: null,
            departure_time: "N/A",
            arrival_time: "N/A",
            return_departure_time: null,
            return_arrival_time: null,
          };
          const taxes_fees = cashFlight.cash_price
            ? Math.min(award.taxes_fees, cashFlight.cash_price * 0.1)
            : award.taxes_fees;
          return {
            ...award,
            cash_price: cashFlight.cash_price || award.taxes_fees / 0.1,
            taxes_fees,
            departure_time: cashFlight.departure_time,
            arrival_time: cashFlight.arrival_time,
            return_departure_time: cashFlight.return_departure_time,
            return_arrival_time: cashFlight.return_arrival_time,
            return_date: cashFlight.return_date || returnDate,
            cpp:
              award.points && cashFlight.cash_price
                ? Math.max(
                    0,
                    ((cashFlight.cash_price - taxes_fees) /
                      ((parseInt(adults) + parseInt(children)) *
                        award.points)) *
                      100
                  )
                : 0,
          };
        })
        .filter((flight) => flight.cash_price);

      res.json(flights);
    } catch (error) {
      console.error("Business flights error:", error.message);
      res.status(500).json({
        error: "Failed to fetch business flights",
        details: error.message,
      });
    }
  }
);

// GET /flights/cash
app.get(
  "/flights/cash",
  ensureAmadeusToken,
  validateFlightQuery,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        origin,
        destination,
        departureDate,
        returnDate,
        adults = 1,
        children = 0,
        tripType = "one-way",
        nonstop = false,
      } = req.query;

      if (tripType === "round" && !returnDate) {
        return res
          .status(400)
          .json({ error: "Missing returnDate for round trip" });
      }

      const cashFlights = await fetchCashFlights(req.amadeusToken, {
        origin,
        destination,
        departureDate,
        returnDate,
        adults: parseInt(adults),
        children: parseInt(children),
        travelClass: "ECONOMY",
        nonstop,
        tripType,
      });
      console.log("Cash Flights:", cashFlights.length);

      res.json(cashFlights);
    } catch (error) {
      console.error("Cash flights error:", error.message);
      res.status(500).json({
        error: "Failed to fetch cash flights",
        details: error.message,
      });
    }
  }
);

// POST /recommend
app.post(
  "/recommend",
  [
    check("user_id").notEmpty().withMessage("User ID is required"),
    check("points_balance.Amex")
      .isInt({ min: 0 })
      .withMessage("Amex points must be a non-negative integer"),
    check("points_balance.Chase")
      .isInt({ min: 0 })
      .withMessage("Chase points must be a non-negative integer"),
    check("travel_goals.origin")
      .isLength({ min: 3, max: 3 })
      .withMessage("Origin must be a 3-letter IATA code"),
    check("travel_goals.destination")
      .isLength({ min: 3, max: 3 })
      .withMessage("Destination must be a 3-letter IATA code"),
    check("travel_goals.departureDate")
      .custom((value) => validateDate(value))
      .withMessage("Invalid departureDate format (YYYY-MM-DD)"),
    check("travel_goals.returnDate")
      .optional()
      .custom((value) => validateDate(value))
      .withMessage("Invalid returnDate format (YYYY-MM-DD)"),
    check("travel_goals.trip_type")
      .isIn(["one-way", "round"])
      .withMessage("Trip type must be one-way or round"),
    check("travel_goals.travelers.adults")
      .isInt({ min: 1 })
      .withMessage("Adults must be a positive integer"),
    check("travel_goals.travelers.children")
      .optional()
      .isArray()
      .withMessage("Children must be an array"),
    check("travel_goals.preferred_cabin")
      .isArray()
      .notEmpty()
      .withMessage("Preferred cabin must be a non-empty array"),
    check("travel_goals.preferences.nonstop")
      .optional()
      .isBoolean()
      .withMessage("Nonstop must be a boolean"),
    check("travel_goals.preferences.arrival_departure")
      .optional()
      .isIn(["flexible", "morning_departure"])
      .withMessage("Arrival/departure must be flexible or morning_departure"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { user_id, points_balance, travel_goals } = req.body;
      const {
        origin,
        destination,
        trip_type,
        travelers,
        preferred_cabin,
        preferences,
        departureDate,
        returnDate,
      } = travel_goals;
      const { nonstop = false, arrival_departure = "flexible" } =
        preferences || {};
      const adults = travelers?.adults || 1;
      const children = travelers?.children?.length || 0;

      if (trip_type === "round" && !returnDate) {
        return res
          .status(400)
          .json({ error: "Missing returnDate for round trip" });
      }

      console.log("Recommendation payload:", {
        user_id,
        points_balance,
        origin,
        destination,
        trip_type,
        departureDate,
        returnDate,
        adults,
        children,
        preferred_cabin,
        nonstop,
        arrival_departure,
      });

      // Ensure Amadeus token
      if (!amadeusToken) {
        await getAmadeusToken();
      }

      // Fetch cash flights
      const cashFlights = await fetchCashFlights(amadeusToken, {
        origin,
        destination,
        departureDate,
        returnDate,
        adults,
        children,
        travelClass: preferred_cabin.includes("business")
          ? "BUSINESS"
          : "ECONOMY",
        nonstop,
        tripType: trip_type,
      });

      // Fetch Seats.aero flights for each cabin
      const seatsAeroResults = await Promise.all(
        preferred_cabin.map((cabin) =>
          getSeatsAeroFlights(
            origin,
            destination,
            departureDate,
            cabin,
            nonstop,
            trip_type === "round" ? returnDate : null
          )
        )
      );

      // Combine flights
      let allFlights = [];
      for (const { outboundFlights, returnFlights } of seatsAeroResults) {
        const outboundProcessed = outboundFlights
          .map((award) => {
            const cashFlight = cashFlights.find(
              (cf) =>
                cf.airline === award.airline &&
                cf.departure_date === award.departure_date &&
                cf.nonstop === award.direct
            ) || {
              cash_price: null,
              departure_time: "N/A",
              arrival_time: "N/A",
              return_departure_time: null,
              return_arrival_time: null,
            };
            const taxes_fees = cashFlight.cash_price
              ? Math.min(award.taxes_fees, cashFlight.cash_price * 0.1)
              : award.taxes_fees;
            return {
              ...award,
              cash_price: cashFlight.cash_price || award.taxes_fees / 0.1,
              taxes_fees,
              departure_time: cashFlight.departure_time,
              arrival_time: cashFlight.arrival_time,
              return_departure_time: cashFlight.return_departure_time,
              return_arrival_time: cashFlight.return_arrival_time,
              return_date: cashFlight.return_date || returnDate,
              cpp:
                award.points && cashFlight.cash_price
                  ? Math.max(
                      0,
                      ((cashFlight.cash_price - taxes_fees) /
                        ((adults + children) * award.points)) *
                        100
                    )
                  : 0,
            };
          })
          .filter((flight) => flight.cash_price);

        allFlights.push(...outboundProcessed);

        if (trip_type === "round") {
          const returnProcessed = returnFlights
            .map((award) => {
              const cashFlight = cashFlights.find(
                (cf) =>
                  cf.airline === award.airline &&
                  cf.return_date === award.departure_date &&
                  cf.nonstop === award.direct
              ) || {
                cash_price: null,
                departure_time: "N/A",
                arrival_time: "N/A",
              };
              const taxes_fees = cashFlight.cash_price
                ? Math.min(award.taxes_fees, cashFlight.cash_price * 0.1)
                : award.taxes_fees;
              return {
                ...award,
                cash_price: cashFlight.cash_price || award.taxes_fees / 0.1,
                taxes_fees,
                departure_time: cashFlight.departure_time,
                arrival_time: cashFlight.arrival_time,
              };
            })
            .filter((flight) => flight.cash_price);

          // Match outbound and return flights
          allFlights = allFlights
            .map((outbound) => {
              const returnFlight = returnProcessed.find(
                (ret) =>
                  ret.airline === outbound.airline &&
                  ret.program === outbound.program &&
                  ret.cabin === outbound.cabin
              );
              if (!returnFlight && trip_type === "round") return null;
              return {
                ...outbound,
                points_used:
                  (adults + children) *
                  outbound.points *
                  (trip_type === "round" ? 2 : 1),
                return_departure_time: returnFlight
                  ? returnFlight.departure_time
                  : outbound.return_departure_time || "N/A",
                return_arrival_time: returnFlight
                  ? returnFlight.arrival_time
                  : outbound.return_arrival_time || "N/A",
                return_date: returnFlight
                  ? returnFlight.departure_date
                  : outbound.return_date,
              };
            })
            .filter((flight) => flight);
        }
      }

      // Filter by preferences
      const filteredFlights = allFlights.filter((flight) => {
        if (nonstop && !flight.direct) return false;
        if (arrival_departure === "flexible" || flight.departure_time === "N/A")
          return true;
        const departureHour = parseInt(flight.departure_time.split(":")[0]);
        return arrival_departure === "morning_departure"
          ? departureHour < 12
          : departureHour >= 12;
      });

      // Get top 3 points-based recommendations
      const pointsRecommendations = filteredFlights
        .filter(
          (f) => points_balance.Amex + points_balance.Chase >= f.points_used
        )
        .sort((a, b) => b.cpp - a.cpp)
        .slice(0, 3)
        .map((f) => ({
          airline: f.airline,
          cabin: f.cabin,
          points_used: f.points_used,
          cash_price: f.cash_price,
          taxes_fees: f.taxes_fees,
          cpp: f.cpp,
          nonstop: f.direct,
          departure_time: f.departure_time,
          arrival_time: f.arrival_time,
          departure_date: f.departure_date,
          return_departure_time: f.return_departure_time,
          return_arrival_time: f.return_arrival_time,
          return_date: f.return_date,
          transfer_from:
            f.program === "aeroplan" || ["BA", "IB"].includes(f.airline)
              ? "Amex"
              : "Chase",
          payment_type: "points",
          program: f.program,
        }));

      // Fallback to cash recommendation
      const cashRecommendation = cashFlights
        .filter((f) => (nonstop ? f.nonstop : true))
        .slice(0, 3)
        .reduce(
          (best, f) =>
            !best.cash_price || f.cash_price < best.cash_price ? f : best,
          { cash_price: Infinity, airline: "" }
        );
      console.log("Cash recommendation:", cashRecommendation);

      let recommendations = pointsRecommendations;
      if (cashRecommendation.airline && !pointsRecommendations.length) {
        //if (cashRecommendation.airline) {
        console.log("Cash recommendation:", cashRecommendation);
        recommendations.push(cashRecommendation);
      }

      if (!recommendations.length) {
        recommendations = [
          { error: "No flights available matching preferences" },
        ];
      }

      console.log("Recommendations:", recommendations);
      res.json({ recommendations });
    } catch (error) {
      console.error("Recommendation error:", error.message);
      res.status(500).json({
        error: "Failed to generate recommendations",
        details: error.message,
      });
    }
  }
);

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
