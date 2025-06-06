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
const CAD_TO_USD = 0.73;

// Validate date format (YYYY-MM-DD)
function validateDate(dateStr) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateStr.match(regex)) return false;
  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date.getTime());
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
        airlinedirect: "YDirectAirlines",
        remainingSeats: "YRemainingSeats",
        currency: "TaxesCurrency",
      },
      premiumeconomy: {
        available: "WAvailable",
        cost: "WMileageCostRaw",
        taxes: "WTotalTaxesRaw",
        direct: "WDirect",
        airline: "WAirlines",
        airlinedirect: "WDirectAirlines",
        remainingSeats: "WRemainingSeats",
        currency: "TaxesCurrency",
      },
      business: {
        available: "JAvailable",
        cost: "JMileageCostRaw",
        taxes: "JTotalTaxesRaw",
        direct: "JDirect",
        airline: "JAirlines",
        airlinedirect: "JDirectAirlines",
        remainingSeats: "JRemainingSeats",
        currency: "TaxesCurrency",
      },
      first: {
        available: "FAvailable",
        cost: "FMileageCostRaw",
        taxes: "FTotalTaxesRaw",
        direct: "FDirect",
        airline: "FAirlines",
        airlinedirect: "FDirectAirlines",
        remainingSeats: "FRemainingSeats",
        currency: "TaxesCurrency",
      },
    };

    const cabinFields = cabinMap[cabin] || cabinMap.economy;

    // Fetch outbound flights
    const params = {
      origin_airport: origin,
      destination_airport: destination,
      start_date: date,
      end_date: date,
      only_direct_flights: nonstop,
      cabin: cabin,
      order_by: "lowest_mileage",
      include_trips: true,
      take: 10,
    };
    console.log(
      `Seats.aero oneway params for ${destination}-${origin} on ${returnDate}:`,
      params
    );
    const outboundResponse = await axios.get(`${SEATS_AERO_API}/search`, {
      params: params,
      headers: {
        "Partner-Authorization": process.env.SEATS_AERO_API_KEY || "",
      },
    });

    console.log(
      `Seats.aero oneway response for ${origin}-${destination} on ${date} in ${cabin} with nonstop ${nonstop}:`,
      outboundResponse.data.data.length
    );

    const outboundFlights = outboundResponse.data.data
      .filter(
        (flight) =>
          flight[cabinFields.available] && flight[cabinFields.direct] == nonstop
      )
      .map((obj) => {
        const trip = obj.AvailabilityTrips.find(
          (trip) => trip.MileageCost === obj[cabinFields.cost]
        );
        const flightNumbers = trip.FlightNumbers.split(", ");
        const lastFlightNumber = flightNumbers[flightNumbers.length - 1];
        const cashPrice = mileageToCash(trip.MileageCost, trip.Source);

        return {
          id: trip.ID,
          origin: trip.OriginAirport,
          destination: trip.DestinationAirport,
          airline: trip.Carriers.split(", ")[0],
          nonstop: trip.Stops === 0,
          departure_date: trip.DepartsAt,
          arrival_date: trip.ArrivesAt,
          return_departure_date: null,
          return_arrival_date: null,
          cabin: trip.Cabin.toUpperCase(),
          flightNumber: lastFlightNumber,
          // diff
          cash_price: 0,
          points_used: trip.MileageCost,
          taxes_fees: trip.TotalTaxes,
          seats_available: trip.RemainingSeats,
          program: trip.Source,
          type: "SeatsAero",
        };
      });

    return outboundFlights;
  } catch (error) {
    console.error(
      `Seats.aero error for ${origin}-${destination}:`,
      error.message
    );
    return [];
  }
}

function mileageToCash(mileageCost, program) {
  const pointValues = {
    american: 0.016,
    qantas: 0.013,
    united: 0.0135,
    delta: 0.012,
    ba: 0.013,
    alaska: 0.018,
  };
  const pointValue = pointValues[program.toLowerCase()];
  console.log("mileageToCash", mileageCost, program.toLowerCase(), pointValue);
  if (!pointValue) {
    return 0;
  }
  return mileageCost * pointValue;
}

// Fetch cash flights from Amadeus with fallback
async function fetchCashFlights(token, params) {
  try {
    let flights = [];
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
            nonStop: params.nonstop,
            ...(params.tripType === "round" && params.returnDate
              ? { returnDate: params.returnDate }
              : {}),
            currencyCode: "USD",
            max: 10,
          },
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      console.log(
        `Amadeus search for ${params.origin}-${params.destination}:`,
        response.data.data.length
      );

      flights = response.data.data.map((flight) => ({
        id: flight.id,
        origin: flight.itineraries[0].segments[0].departure.iataCode,
        destination: flight.itineraries[0].segments.at(-1).arrival.iataCode,
        airline: flight.itineraries[0].segments[0].carrierCode,
        nonstop: flight.itineraries[0].segments.length === 1,
        departure_date: flight.itineraries[0].segments[0].departure.at,
        arrival_date: flight.itineraries[0].segments[0].arrival.at,
        return_departure_date:
          params.tripType === "round" && flight.itineraries[1]
            ? flight.itineraries[1].segments[0].departure.at
            : null,
        return_arrival_date:
          params.tripType === "round" && flight.itineraries[1]
            ? flight.itineraries[1].segments[0].arrival.at
            : null,
        cabin: params.travelClass,
        flightNumber:
          flight.itineraries[0].segments[0].operating &&
          flight.itineraries[0].segments[0].operating.carrierCode
            ? `${flight.itineraries[0].segments[0].operating.carrierCode}${flight.itineraries[0].segments[0].number}`
            : `${flight.itineraries[0].segments[0].carrierCode}${flight.itineraries[0].segments[0].number}`,
        // diff
        cash_price: parseFloat(flight.price.total),
        points_used: 0,
        taxes_fees: 0,
        seats_available: 0,
        program: flight.Source,
        type: "Amadeus",
      }));
    } catch (error) {
      console.error(
        `Amadeus error for ${params.origin}-${params.destination}:`,
        error.message
      );
    }

    console.log(
      `Amadeus response for ${params.origin}-${params.destination}:`,
      flights.length
    );
    return flights;
  } catch (error) {
    console.error(
      `Amadeus cash flights error for ${params.origin}-${params.destination}:`,
      error.message
    );
    return [];
  }
}

// Input validation for flight queries
const validateFlightQuery = [
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
];

app.get("/", [], (req, res) => res.send("Express on Vercel"));

// POST /recommend
app.post("/flight-search", validateFlightQuery, async (req, res) => {
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

    console.log("Intent payload:", {
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

    // Fetch cash flights for each cabin
    const cashFlightsNested = await Promise.all(
      preferred_cabin.map((cabin) =>
        fetchCashFlights(amadeusToken, {
          origin,
          destination,
          departureDate,
          returnDate,
          adults,
          children,
          travelClass: cabin.toUpperCase(),
          nonstop,
          tripType: trip_type,
        })
      )
    );
    const cashFlights = cashFlightsNested.flat();
    console.log("Cash flights:", cashFlights.length);

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
    const seatsAeroFlights = seatsAeroResults.flat();
    const allFlights = [...cashFlights, ...seatsAeroFlights];

    res.json({ allFlights });
  } catch (error) {
    console.error("Recommendation error:", error.message);
    res.status(500).json({
      error: "Failed to generate recommendations",
      details: error.message,
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
export default app;
