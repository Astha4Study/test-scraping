// Import the GMaps library from the lib directory
// import GMaps from "../lib/map";
import GMaps from "../lib/gMaps";

// Main asynchronous function that runs the scraper
async function main() {
  // Create an instance of the GMaps class
  const gMapsInstance = new GMaps();
  // return gMapsInstance.initBrowser();

  // Flag to decide whether to save data to the database
  // Set to true if you want to save to the database
  const saveToDB = true;

  // List of categories for places to search (e.g., mountains, beaches)
  const categories = ["terminal", "stasiun", "bandara"];

  // List of provinces in Indonesia to search in
  const provinces = [
    "aceh",
    "sumatera utara",
    "sumatera barat",
    "riau",
    "kepulauan riau",
    "jambi",
    "bengkulu",
    "sumatera selatan",
    "kepulauan bangka belitung",
    "lampung",

    "dki jakarta",
    "banten",
    "jawa barat",
    "jawa tengah",
    "di yogyakarta",
    "jawa timur",

    "bali",
    "nusa tenggara barat",
    "nusa tenggara timur",

    "kalimantan barat",
    "kalimantan tengah",
    "kalimantan selatan",
    "kalimantan timur",
    "kalimantan utara",

    "sulawesi utara",
    "sulawesi tengah",
    "sulawesi selatan",
    "sulawesi tenggara",
    "gorontalo",
    "sulawesi barat",

    "maluku",
    "maluku utara",

    "papua",
    "papua barat",
    "papua selatan",
    "papua tengah",
    "papua pegunungan",
    "papua barat daya",
  ];

  // List of API keys for Google Maps API (replace with actual keys)
  // Using multiple keys in round-robin to avoid rate limits
  const apiKeys = ["API_KEY_1", "API_KEY_2", "API_KEY_3", "API_KEY_4"];

  // Index to keep track of the current API key in round-robin
  let currentKeyIndex = 0;

  // Function to get the next API key in a round-robin fashion
  function getNextApiKey() {
    const apiKey = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return apiKey;
  }

  for (const cat of categories) {
    for (const prov of provinces) {
      const query = `${cat} di ${prov}`;
      const apikey = getNextApiKey();
      await gMapsInstance.getDetails(query, saveToDB, apikey);
    }
  }

  // Log a message when all scraping is done
  console.log("sudah done");
}

// Call the main function to start the scraper
main();
