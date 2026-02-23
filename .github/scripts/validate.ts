import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "../..");
const DATA_DIR = join(ROOT, "data");
const SCHEMA_DIR = join(DATA_DIR, "_schema");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function findDataFiles(
  dir: string,
  filename: string,
  results: string[] = []
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "_schema") {
      findDataFiles(full, filename, results);
    } else if (entry.isFile() && entry.name === filename) {
      results.push(full);
    }
  }
  return results;
}

interface CityEntry {
  id: string;
  data_path: string;
}

function main() {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  const scheduleSchema = loadJson(join(SCHEMA_DIR, "schedule.schema.json"));
  const separationSchema = loadJson(
    join(SCHEMA_DIR, "separation.schema.json")
  );

  const validateSchedule = ajv.compile(scheduleSchema as object);
  const validateSeparation = ajv.compile(separationSchema as object);

  let hasErrors = false;

  // Validate all schedule.json files
  const scheduleFiles = findDataFiles(join(DATA_DIR, "jp"), "schedule.json");
  for (const file of scheduleFiles) {
    const data = loadJson(file);
    if (!validateSchedule(data)) {
      console.error(`FAIL ${file.replace(ROOT + "/", "")}`);
      for (const err of validateSchedule.errors ?? []) {
        console.error(`  ${err.instancePath} ${err.message}`);
      }
      hasErrors = true;
    } else {
      console.log(`OK   ${file.replace(ROOT + "/", "")}`);
    }
  }

  // Validate all separation.json files
  const separationFiles = findDataFiles(
    join(DATA_DIR, "jp"),
    "separation.json"
  );
  for (const file of separationFiles) {
    const data = loadJson(file);
    if (!validateSeparation(data)) {
      console.error(`FAIL ${file.replace(ROOT + "/", "")}`);
      for (const err of validateSeparation.errors ?? []) {
        console.error(`  ${err.instancePath} ${err.message}`);
      }
      hasErrors = true;
    } else {
      console.log(`OK   ${file.replace(ROOT + "/", "")}`);
    }
  }

  // Validate cities.json consistency
  const citiesPath = join(DATA_DIR, "cities.json");
  if (existsSync(citiesPath)) {
    const cities = loadJson(citiesPath) as {
      cities: CityEntry[];
    };

    for (const city of cities.cities) {
      const cityDir = join(DATA_DIR, city.data_path);
      if (!existsSync(cityDir)) {
        console.error(
          `FAIL cities.json: directory missing for ${city.id} (${city.data_path})`
        );
        hasErrors = true;
      }

      // schedule.json is always required (never shared)
      if (!existsSync(join(cityDir, "schedule.json"))) {
        console.error(`FAIL cities.json: schedule.json missing for ${city.id}`);
        hasErrors = true;
      }

      if (!existsSync(join(cityDir, "separation.json"))) {
        console.error(
          `FAIL cities.json: separation.json missing for ${city.id}`
        );
        hasErrors = true;
      }
    }
    console.log(`OK   cities.json consistency check`);
  }

  if (hasErrors) {
    console.error("\nValidation failed.");
    process.exit(1);
  } else {
    console.log("\nAll validations passed.");
  }
}

main();
