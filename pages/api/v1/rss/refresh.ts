import { prisma } from "@/lib/api/db";
import verifyUser from "@/lib/api/verifyUser";
import { NextApiRequest, NextApiResponse } from "next";
import Parser from "rss-parser";
import { hasPassedLimit } from "@/lib/api/verifyCapacity";
import axios from "axios";
import https from "https";

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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Vérifier que c'est une requête POST
  if (req.method !== "POST") {
    return res.status(405).json({ response: "Method not allowed" });
  }

  // Vérifier l'authentification
  const user = await verifyUser({ req, res });
  if (!user) return;

  try {
    // Récupérer tous les flux RSS
    const rssSubscriptions = await prisma.rssSubscription.findMany({
      where: {
        ownerId: user.id
      }
    });

    // Traiter chaque flux RSS
    const results = await Promise.allSettled(
      rssSubscriptions.map(async (rssSubscription) => {
        try {
          // Récupérer et parser le flux RSS
          const rssContent = await fetchRSSContent(rssSubscription.url);
          const feed = await parser.parseString(rssContent);

          // Vérifier les articles existants
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

          // Filtrer les nouveaux articles
          const newItems = feed.items.filter(item => 
            item.link && !existingUrls.map(link => link.url).includes(item.link)
          );

          if (newItems.length > 0) {
            // Vérifier la limite d'articles
            const hasTooManyLinks = await hasPassedLimit(
              rssSubscription.ownerId,
              newItems.length
            );

            if (hasTooManyLinks) {
              return {
                subscription: rssSubscription.name,
                status: "skipped",
                reason: "Too many links"
              };
            }

            // Créer les nouveaux liens
            await Promise.all(
              newItems.map(async (item) => {
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

            // Mettre à jour lastBuildDate
            const mostRecentDate = new Date(Math.max(...newItems.map(item => 
              new Date(item.isoDate || item.pubDate || new Date()).getTime()
            )));

            await prisma.rssSubscription.update({
              where: { id: rssSubscription.id },
              data: { lastBuildDate: mostRecentDate },
            });

            return {
              subscription: rssSubscription.name,
              status: "success",
              newItems: newItems.length
            };
          }

          return {
            subscription: rssSubscription.name,
            status: "success",
            newItems: 0
          };

        } catch (error) {
          return {
            subscription: rssSubscription.name,
            status: "error",
            error: error.message
          };
        }
      })
    );

    return res.status(200).json({ 
      response: "RSS feeds refreshed",
      details: results
    });

  } catch (error) {
    console.error("Error refreshing RSS feeds:", error);
    return res.status(500).json({ 
      response: "Error refreshing RSS feeds",
      error: error.message
    });
  }
} 