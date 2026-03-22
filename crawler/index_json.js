// CLI entrypoint for exporting HelloFresh recipes as JSON files.
const yargs = require("yargs");
const { colours } = require("./utils/colours");
const helloFreshJson = require("./services/hello-fresh-json");

// Parse command-line configurations
const argv = yargs
  .strict(true)
  .usage("Usage: $0 <command> [options]")
  .command("HelloFresh", "Export HelloFresh recipes as JSON", {
    locale: {
      alias: "l",
      describe: "Locale to perform crawling on.",
      choices: ["US", "GB", "DE", "FR", "ES"],
      default: "US",
      nargs: 1,
    },
    jsonSaveDirectory: {
      alias: "s",
      describe: "Directory where to save JSON recipe files.",
      default: "./recipes-json",
      nargs: 1,
    },
    format: {
      alias: "f",
      describe: "Output format: 'single' (one file with all recipes) or 'multiple' (one file per recipe).",
      choices: ["single", "multiple"],
      default: "single",
      nargs: 1,
    },
  })
  .demandCommand(1, 1, "Please specify which service should be used")
  .example(
    "$0 HelloFresh -l ES -s ./my-recipes -f multiple",
    "Export Spanish Hello Fresh recipes to individual JSON files"
  )
  .example(
    "$0 HelloFresh -l GB -f single",
    "Export UK recipes to a single JSON file"
  ).argv;

console.log(
  colours.fg.green,
  `Exporting recipes from ${argv._} using ${argv.locale} locale`,
  colours.reset
);
console.log(
  `Output format: ${argv.format} | Directory: ${argv.jsonSaveDirectory}\n`
);

if (argv._[0] === "HelloFresh") {
  helloFreshJson
    .crawlJson(argv)
    .catch(console.error)
    .finally(() => {
      console.log(
        "\nThe export process has completed. Press enter to exit..."
      );
      process.stdin.resume();
      process.stdin.on("data", process.exit.bind(process, 0));
    });
}
