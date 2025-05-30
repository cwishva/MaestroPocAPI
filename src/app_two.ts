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
    setTimeout(() => (amadeusToken = ""), response.data.expires_in * 1000); // Clear token after expiry
    return amadeusToken;
  } catch (error) {
    console.error("Amadeus token error:", error.message);
    throw new Error("Failed to get Amadeus token");
  }
}

async function searchFlights(intentPayload) {
  const token = await getAmadeusToken();
  const {
    origin,
    destination,
    departureDate,
    returnDate,
    travelers,
    preferred_cabin,
    preferences,
  } = intentPayload.travel_goals;
  const adults = travelers.adults;
  const children = travelers.children.length;

  const response = await axios.get(
    "https://test.api.amadeus.com/v2/shopping/flight-offers",
    {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate,
        returnDate,
        adults,
        children,
        nonStop: preferences.nonstop,
        travelClass: preferred_cabin[0].toUpperCase(),
        currencyCode: "USD",
      },
    }
  );

  return response.data.data;
}

function matchPointsAndRecommend(flights, pointsBalance) {
  const recommendations = [];

  for (let flight of flights) {
    // Placeholder: replace with actual points data from Seats.aero
    const requiredPoints = estimatePointsForFlight(flight);

    const sources = Object.entries(pointsBalance);
    for (let [program, balance] of sources) {
      if (balance >= requiredPoints) {
        recommendations.push({ flight, program, requiredPoints });
        break;
      }
    }

    if (recommendations.length >= 3) break;
  }

  return recommendations;
}

function suggestCashIfNoPointsMatch(flights, recommendations) {
  if (recommendations.length === 0) {
    const cheapest = flights
      .sort((a, b) => a.price.total - b.price.total)
      .slice(0, 3);
    return cheapest.map((flight) => ({
      flight,
      cashPrice: flight.price.total,
    }));
  }
  return recommendations;
}

app.post("/recommend-flights", async (req, res) => {
  const intentPayload = req.body;

  try {
    const flights = await searchFlights(intentPayload);
    const recommendations = matchPointsAndRecommend(
      flights,
      intentPayload.points_balance
    );
    const finalSuggestions = suggestCashIfNoPointsMatch(
      flights,
      recommendations
    );

    res.json({ recommendations: finalSuggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
