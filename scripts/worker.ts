import "dotenv/config";
import { Collection, Link, User } from "@prisma/client";
import { prisma } from "../lib/api/db";
import archiveHandler from "../lib/api/archiveHandler";
import Parser from "rss-parser";
import { hasPassedLimit } from "../lib/api/verifyCapacity";
import axios from "axios";
import https from "https";

const args = process.argv.slice(2).join(" ");

const archiveTakeCount = Number(process.env.ARCHIVE_TAKE_COUNT || "") || 5;

// Configuration HTTPS
const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.IGNORE_UNAUTHORIZED_CA === "true" ? false : true,
});

// Configurer le parser RSS avec axios
const parser = new Parser({
  customFields: {
    item: ['media:content'],
  },
  requestOptions: {
    agent: httpsAgent
  }
});

// Fonction pour récupérer le flux RSS avec axios
async function fetchRSSContent(url: string) {
  try {
    const response = await axios.get(url, {
      httpsAgent,
      timeout: 10000 // 10 secondes timeout
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching RSS feed:", error);
    throw error;
  }
}

type LinksAndCollectionAndOwner = Link & {
  collection: Collection & {
    owner: User;
  };
};

async function processBatch() {
  const linksOldToNew = await prisma.link.findMany({
    where: {
      url: { not: null },
      OR: [
        {
          image: null,
        },
        {
          pdf: null,
        },
        {
          readable: null,
        },
        {
          monolith: null,
        },
      ],
    },
    take: archiveTakeCount,
    orderBy: { id: "asc" },
    include: {
      collection: {
        include: {
          owner: true,
        },
      },
    },
  });

  const linksNewToOld = await prisma.link.findMany({
    where: {
      url: { not: null },
      OR: [
        {
          image: null,
        },
        {
          pdf: null,
        },
        {
          readable: null,
        },
        {
          monolith: null,
        },
      ],
    },
    take: archiveTakeCount,
    orderBy: { id: "desc" },
    include: {
      collection: {
        include: {
          owner: true,
        },
      },
    },
  });

  const archiveLink = async (link: LinksAndCollectionAndOwner) => {
    try {
      console.log(
        "\x1b[34m%s\x1b[0m",
        `Processing link ${link.url} for user ${link.collection.ownerId}`
      );

      await archiveHandler(link);

      console.log(
        "\x1b[34m%s\x1b[0m",
        `Succeeded processing link ${link.url} for user ${link.collection.ownerId}.`
      );
    } catch (error) {
      console.error(
        "\x1b[34m%s\x1b[0m",
        `Error processing link ${link.url} for user ${link.collection.ownerId}:`,
        error
      );
    }
  };

  // Process each link in the batch concurrently
  const processingPromises = [...linksOldToNew, ...linksNewToOld]
    // Make sure we don't process the same link twice
    .filter((value, index, self) => {
      return self.findIndex((item) => item.id === value.id) === index;
    })
    .map((e) => archiveLink(e));

  await Promise.allSettled(processingPromises);
}

async function fetchAndProcessRSS() {
  console.log("\x1b[34m%s\x1b[0m", "Fetching RSS subscriptions...");
  const rssSubscriptions = await prisma.rssSubscription.findMany({});
  console.log("\x1b[34m%s\x1b[0m", `Found ${rssSubscriptions.length} RSS subscriptions`);

  await Promise.all(
    rssSubscriptions.map(async (rssSubscription) => {
      try {
        console.log("\x1b[34m%s\x1b[0m", `Fetching feed for ${rssSubscription.name} (${rssSubscription.url})`);
        
        // Utiliser axios pour récupérer le contenu RSS
        const rssContent = await fetchRSSContent(rssSubscription.url);
        const feed = await parser.parseString(rssContent);
        
        // Afficher les dates des 5 premiers articles
        console.log("\x1b[34m%s\x1b[0m", `Feed ${rssSubscription.name} - Latest articles:`);
        feed.items.slice(0, 5).forEach((item, index) => {
          console.log("\x1b[34m%s\x1b[0m", `Article ${index + 1}: ${item.title}`);
          console.log("\x1b[34m%s\x1b[0m", `- pubDate: ${item.pubDate}`);
          console.log("\x1b[34m%s\x1b[0m", `- isoDate: ${item.isoDate}`);
        });

        // Vérifier si nous avons déjà des liens de ce flux RSS
        const existingUrls = await prisma.link.findMany({
          where: {
            collection: {
              id: rssSubscription.collectionId
            },
            url: {
              in: feed.items.map(item => item.link).filter((url): url is string => url !== undefined)
            }
          },
          select: {
            url: true
          }
        });

        let itemsToProcess = feed.items;
        
        if (existingUrls.length > 0) {
          // Si nous avons déjà des articles de ce flux, filtrer par date
          const lastCheck = new Date(rssSubscription.lastBuildDate || 0);
          itemsToProcess = feed.items.filter(item => {
            const itemDate = new Date(item.isoDate || item.pubDate || new Date());
            const isNewer = itemDate > lastCheck;
            console.log("\x1b[34m%s\x1b[0m", `Article ${item.title} date comparison: ${itemDate.toISOString()} > ${lastCheck.toISOString()} = ${isNewer}`);
            return isNewer;
          });
        } else {
          console.log("\x1b[34m%s\x1b[0m", `No existing articles found for feed ${rssSubscription.name}, processing all ${feed.items.length} items without date filtering`);
          itemsToProcess = feed.items;
        }

        console.log("\x1b[34m%s\x1b[0m", `Found ${itemsToProcess.length} items to process for ${rssSubscription.name}`);

        if (itemsToProcess.length > 0) {
          const newItems = itemsToProcess.filter(item => item.link && !existingUrls.map(link => link.url).includes(item.link));
          console.log("\x1b[34m%s\x1b[0m", `Found ${newItems.length} new items for ${rssSubscription.name}`);

          if (newItems.length > 0) {
        const hasTooManyLinks = await hasPassedLimit(
          rssSubscription.ownerId,
          newItems.length
        );

        if (hasTooManyLinks) {
          console.log(
            "\x1b[34m%s\x1b[0m",
            `User ${rssSubscription.ownerId} has too many links. Skipping new RSS feed items.`
          );
          return;
        }

            await Promise.all(
              newItems.map(async (item) => {
                console.log("\x1b[34m%s\x1b[0m", `Creating new link for item: ${item.title}`);
          await prisma.link.create({
            data: {
              name: item.title,
              url: item.link,
              type: "link",
              createdBy: {
                connect: {
                  id: rssSubscription.ownerId,
                },
              },
              collection: {
                connect: {
                  id: rssSubscription.collectionId,
                },
              },
            },
          });
              })
            );

            const mostRecentDate = new Date(Math.max(...newItems.map(item => 
              new Date(item.isoDate || item.pubDate || new Date()).getTime()
            )));

        await prisma.rssSubscription.update({
          where: { id: rssSubscription.id },
              data: { lastBuildDate: mostRecentDate },
            });
            console.log("\x1b[34m%s\x1b[0m", `Updated lastBuildDate for ${rssSubscription.name} to ${mostRecentDate.toISOString()}`);
          } else {
            console.log("\x1b[34m%s\x1b[0m", `No new items to add for ${rssSubscription.name}`);
          }
        } else {
          console.log("\x1b[34m%s\x1b[0m", `No items to process for ${rssSubscription.name}`);
      }
    } catch (error) {
      console.error(
        "\x1b[34m%s\x1b[0m",
        `Error processing RSS feed ${rssSubscription.url}:`,
        error
      );
    }
    })
  );
}

function delay(sec: number) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

const pollingIntervalInSeconds =
  (Number(process.env.NEXT_PUBLIC_RSS_POLLING_INTERVAL_MINUTES) || 60) * 60; // Default to one hour if not set

async function startRSSPolling() {
  console.log("\x1b[34m%s\x1b[0m", "Starting RSS polling...");
  while (true) {
    await fetchAndProcessRSS();
    await delay(pollingIntervalInSeconds);
  }
}

const archiveIntervalInSeconds =
  Number(process.env.ARCHIVE_SCRIPT_INTERVAL) || 10;

async function startArchiveProcessing() {
  console.log("\x1b[34m%s\x1b[0m", "Starting link preservation...");
  while (true) {
    await processBatch();
    await delay(archiveIntervalInSeconds);
  }
}

async function init() {
  console.log("\x1b[34m%s\x1b[0m", "Initializing application...");
  startRSSPolling();
  startArchiveProcessing();
}

init();