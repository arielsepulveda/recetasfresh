// Service that crawls HelloFresh recipes and exports them as JSON.
const axios = require("axios");
const fs = require("fs");
const { colours } = require("../utils/colours");

let siteUrl = "https://www.hellofresh.com";
const apiUrl = "https://gw.hellofresh.com/api/";
const searchEndpoint = "recipes/search?";
let jsonSaveDirectory = "./recipes-json";
let outputFormat = "single"; // "single" = one big file, "multiple" = one file per recipe

const apiSearchParams = {
  offset: 0,
  limit: 500,
  product: ["classic-box", "veggie-box", "meal-plan", "family-box"],
  locale: "en-US",
  country: "us",
  ["max-prep-time"]: 60,
};

const fetchApiToken = async function () {
  try {
    // Load the regular site to grab an access token
    const siteResponse = await axios.get(siteUrl);
    const responseData = siteResponse.data;

    // Use a regular expression to extract the access token
    const regex = /"access_token":"([^"]+)"/;
    const match = responseData.match(regex);

    if (match) {
      const accessToken = match[1];
      return accessToken;
    } else {
      throw new Error("Access token not found in the site response.");
    }
  } catch (error) {
    throw new Error("Failed to fetch the API token: " + error.message);
  }
};

const constructSearchUrl = function () {
  let target = `${apiUrl}${searchEndpoint}`;

  for (let [key, value] of Object.entries(apiSearchParams)) {
    if (Array.isArray(value)) {
      target += `${key}=${value.join("|")}&`;
    } else {
      target += `${key}=${value}&`;
    }
  }

  return target.slice(0, target.length - 1);
};

const performSearch = async function (bearerToken) {
  const searchUrl = constructSearchUrl();
  return axios.get(searchUrl, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });
};

const sanitizeFilename = function (filename) {
  // Remove invalid characters for Windows filenames: < > : " / \ | ? *
  return filename.replace(/[<>:"|?*]/g, "").trim();
};

const saveRecipesAsJson = async function (allRecipes) {
  if (outputFormat === "single") {
    // Save all recipes to one file
    try {
      const filePath = `${jsonSaveDirectory}/recipes.json`;
      fs.writeFileSync(filePath, JSON.stringify(allRecipes, null, 2));
      console.log(`✓ Saved ${allRecipes.length} recipes to ${filePath}`);
    } catch (err) {
      console.log(`✗ Error saving recipes file: ${err.message}`);
    }
  } else if (outputFormat === "multiple") {
    // Save each recipe to its own file
    let savedCount = 0;
    let failedCount = 0;

    for (const recipe of allRecipes) {
      try {
        const sanitizedName = sanitizeFilename(recipe.name);
        const filePath = `${jsonSaveDirectory}/${sanitizedName}.json`;

        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, JSON.stringify(recipe, null, 2));
          savedCount++;
        }
      } catch (err) {
        console.log(`✗ Error saving "${recipe.name}": ${err.message}`);
        failedCount++;
      }
    }

    console.log(
      `✓ Saved ${savedCount} recipe files, ${failedCount} failed.`
    );
  }
};

const crawlJson = async function (settings) {
  if (settings.locale) {
    if (settings.locale === "DE") {
      apiSearchParams.locale = `de-${settings.locale.toUpperCase()}`;
      siteUrl = "https://www.hellofresh.de";
    } else if (settings.locale === "FR") {
      apiSearchParams.locale = `fr-${settings.locale.toUpperCase()}`;
      siteUrl = "https://www.hellofresh.fr";
    } else if (settings.locale === "ES") {
      apiSearchParams.locale = `es-${settings.locale.toUpperCase()}`;
      siteUrl = "https://www.hellofresh.es";
    } else {
      apiSearchParams.locale = `en-${settings.locale.toUpperCase()}`;
    }

    apiSearchParams.country = settings.locale.toLowerCase();
  }

  if (settings.jsonSaveDirectory) {
    jsonSaveDirectory = settings.jsonSaveDirectory;
  }

  if (settings.format) {
    outputFormat = settings.format; // "single" or "multiple"
  }

  // Create directory if it doesn't exist
  fs.mkdirSync(jsonSaveDirectory, { recursive: true });

  const apiToken = await fetchApiToken();

  if (!apiToken) {
    throw new Error("API bearer token could not be extracted.");
  }

  console.log(colours.fg.green, "API Token acquired. Searching recipes.", colours.reset);

  // Initiate search
  let searchResponse = await performSearch(apiToken);

  if (searchResponse.status !== 200) {
    throw new Error(
      `Search responded with status ${searchResponse.status}. Aborting.`
    );
  }

  if (searchResponse.data.items.length < 1) {
    throw new Error("No results have been retrieved.");
  }

  let currentPage = 1;
  let pages = Math.round(
    (searchResponse.data.total - searchResponse.data.skip) /
    apiSearchParams.limit
  );

  console.log(
    `Initiating download of ${searchResponse.data.total} recipes over ${pages} batches.`
  );

  const allRecipes = [];

  while (currentPage <= pages) {
    console.log(
      colours.fg.green,
      `Batch [${currentPage}/${pages}] Processing ${searchResponse.data.items.length} recipes:`,
      colours.reset
    );

    // Collect all recipe data
    searchResponse.data.items.forEach((item) => {
      allRecipes.push(item);
      console.log(`  - ${item.name}`);
    });

    apiSearchParams.offset += apiSearchParams.limit;
    searchResponse = await performSearch(apiToken);

    if (searchResponse.status !== 200) {
      throw new Error(
        `Search responded with status ${searchResponse.status}. Aborting.`
      );
    }

    if (searchResponse.data.items.length < 1) {
      console.log("No more results retrieved.");
      break;
    }

    currentPage++;
  }

  console.log(`\nTotal recipes collected: ${allRecipes.length}`);
  console.log("Saving recipes to disk...");

  // Save the recipes
  await saveRecipesAsJson(allRecipes);

  console.log("✓ JSON export completed successfully!");

  // Print a summary of fields in the first recipe
  if (allRecipes.length > 0) {
    console.log(
      "\nSample recipe fields:",
      Object.keys(allRecipes[0]).join(", ")
    );
  }
};

module.exports = { crawlJson };
