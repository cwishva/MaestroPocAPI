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
        //&& !flight[cabinFields.airline].includes(",")
      )
      .map((flight) => {
        const taxes_fees =
          flight[cabinFields.currency] !== "USD"
            ? (flight[cabinFields.taxes] / 100) * CAD_TO_USD
            : flight[cabinFields.taxes] / 100;
        return {
          id: flight.ID,
          airline: nonstop
            ? flight[cabinFields.airlinedirect]
            : flight[cabinFields.airline],
          points_used: flight[cabinFields.cost],
          taxes_fees,
          direct: flight[cabinFields.direct],
          origin: flight.Route.OriginAirport,
          destination: flight.Route.DestinationAirport,
          departure_date: flight.Date,
          cabin: cabin,
          seats_available: flight[cabinFields.remainingSeats],
          program: flight.Source,
          trips: flight.AvailabilityTrips,
        };
      });

    // Fetch return flights if returnDate is provided self call
    let returnFlights = [];
    if (returnDate) {
      console.log(
        `Seats.aero return params for ${destination}-${origin} on ${returnDate}:`,
        params
      );
      const returnResponse = await getSeatsAeroFlights(
        destination,
        origin,
        returnDate,
        cabin,
        nonstop
      );
      console.log(
        `Seats.aero return response for ${destination}-${origin} on ${returnDate}:`,
        returnResponse.outboundFlights.length
      );

      returnFlights = returnResponse.outboundFlights;
    }

    console.log(
      `Seats.aero outbound/inbound flights for ${origin}-${destination} on ${date} in ${cabin} with nonstop ${nonstop}:`,
      JSON.stringify({ outboundFlights, returnFlights }, null, 2)
    );
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
        cabin: params.travelClass,
        flightNumber:
          flight.itineraries[0].segments[0].operating &&
          flight.itineraries[0].segments[0].operating.carrierCode
            ? `${flight.itineraries[0].segments[0].operating.carrierCode}${flight.itineraries[0].segments[0].number}`
            : `${flight.itineraries[0].segments[0].carrierCode}${flight.itineraries[0].segments[0].number}`,
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

    // Fetch cash flights
    // const cashFlights = await fetchCashFlights(amadeusToken, {
    //   origin,
    //   destination,
    //   departureDate,
    //   returnDate,
    //   adults,
    //   children,
    //   travelClass: preferred_cabin.includes("business")
    //     ? "BUSINESS"
    //     : "ECONOMY",
    //   nonstop,
    //   tripType: trip_type,
    // });
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

    // Combine flights
    let allFlights = [];
    for (const { outboundFlights, returnFlights } of seatsAeroResults) {
      const outboundProcessed = outboundFlights
        .map((award) => {
          const cashFlight = cashFlights.find(
            (cf) =>
              cf.airline === award.airline &&
              cf.departure_date === award.departure_date &&
              cf.nonstop === award.direct &&
              cf.cabin.toUpperCase() === award.cabin.toUpperCase()
          ) || {
            cash_price: null,
            departure_time: "N/A",
            arrival_time: "N/A",
            return_departure_time: null,
            return_arrival_time: null,
          };
          // console.log(
          //   "Cash flight map:",
          //   award.airline,
          //   award.departure_date,
          //   award.direct,
          //   award.cabin,
          //   cashFlight
          // );
          return {
            ...award,
            cash_price: cashFlight.cash_price,
            taxes_fees: award.taxes_fees,
            departure_time: cashFlight.departure_time,
            arrival_time: cashFlight.arrival_time,
            return_departure_time: cashFlight.return_departure_time,
            return_arrival_time: cashFlight.return_arrival_time,
            return_date: cashFlight.return_date || returnDate,
            cpp: cashFlight.cash_price
              ? ((cashFlight.cash_price - award.taxes_fees) /
                  ((adults + children) * award.points_used)) *
                100
              : 0,
          };
        })
        .filter((flight) => flight.cash_price);

      //console.log("Outbound processed:", outboundProcessed);
      console.log("Outbound flights:", outboundProcessed.length);
      allFlights.push(...outboundProcessed);

      if (trip_type === "round" && allFlights.length > 0) {
        const returnProcessed = returnFlights
          .map((award) => {
            const cashFlight = cashFlights.find(
              (cf) =>
                cf.airline === award.airline &&
                cf.return_date === award.departure_date &&
                cf.nonstop === award.direct &&
                cf.cabin.toUpperCase() === award.cabin.toUpperCase()
            ) || {
              cash_price: null,
              departure_time: "N/A",
              arrival_time: "N/A",
            };
            //console.log("award", award);
            // const taxes_fees = cashFlight.cash_price
            //   ? Math.min(award.taxes_fees, cashFlight.cash_price * 0.1)
            //   : award.taxes_fees;
            return {
              ...award,
              cash_price: cashFlight.cash_price,
              taxes_fees: award.taxes_fees,
              departure_time: cashFlight.departure_time,
              arrival_time: cashFlight.arrival_time,
              // cpp:cashFlight.cash_price
              // ? ((cashFlight.cash_price - award.taxes_fees) /
              //     ((adults + children) * award.points_used)) *
              //   100
              // : 0,
            };
          })
          .filter((flight) => flight.cash_price);

        console.log("return flights:", returnProcessed.length);

        // Match outbound and return flights
        allFlights = allFlights
          .map((outbound) => {
            const returnFlight = returnProcessed.find(
              (ret) =>
                ret.airline === outbound.airline &&
                ret.program === outbound.program &&
                ret.cabin.toUpperCase() === outbound.cabin.toUpperCase()
            );
            console.log("return flight map:", returnFlight, outbound);
            if (!returnFlight && trip_type === "round") return null;

            console.log(
              "taxes_fees:",
              outbound.taxes_fees + (returnFlight?.taxes_fees || 0)
            );
            return {
              ...outbound,
              taxes_fees: outbound.taxes_fees + (returnFlight?.taxes_fees || 0),
              points_used:
                (adults + children) *
                outbound.points_used *
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

        // const indexOut = allFlights.findIndex(
        //   (f) =>
        //     f.cabin?.toUpperCase() === returnMatchedFlights.cabin?.toUpperCase()
        // );

        // console.log(
        //   "returnMatchedFlights:",
        //   allFlights,
        //   index,
        //   returnMatchedFlights
        // );
        // if (index !== -1) {
        //   allFlights[index] = { ...allFlights[index], ...returnMatchedFlights }; // replaces the whole object
        // }

        // allFlights = allFlights.map((flight) =>
        //   flight.cabin?.toUpperCase() ===
        //   returnMatchedFlights.cabin?.toUpperCase()
        //     ? { ...flight, ...returnMatchedFlights }
        //     : flight
        // );
      }
    }

    console.log("All flights:", allFlights.length);

    // Filter by preferences
    // const filteredFlights = allFlights.filter((flight) => {
    //   if (nonstop && !flight.direct) return false;
    //   if (arrival_departure === "flexible" || flight.departure_time === "N/A")
    //     return true;
    //   const departureHour = parseInt(flight.departure_time.split(":")[0]);
    //   return arrival_departure === "morning_departure"
    //     ? departureHour < 12
    //     : departureHour >= 12;
    // });
    //console.log("Filtered flights:", filteredFlights);
    const filteredFlights = allFlights;

    // Get top 3 points-based recommendations
    const pointsRecommendations = filteredFlights
      .filter(
        (f) => points_balance.Amex + points_balance.Chase >= f.points_used
      )
      .sort((a, b) => b.cpp - a.cpp)
      .slice(0, 5)
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
    console.log("Points recommendations:", pointsRecommendations);

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
        {
          error: "No flights available matching preferences",
        } as unknown as any,
      ];
    }

    console.log("Recommendations:", recommendations);
    res.json({ cashFlights, seatsAeroResults, recommendations });
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
