import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "pages/api/auth/[...nextauth]";
import getCollections from "@/lib/api/controllers/collections/getCollections";
import postCollection from "@/lib/api/controllers/collections/postCollection";

type Data = {
  response: object[] | string;
};

export default async function (
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const session = await getServerSession(req, res, authOptions);

  if (!session?.user?.email) {
    return res.status(401).json({ response: "You must be logged in." });
  }

  if (req.method === "GET") return await getCollections(req, res, session);

  if (req.method === "POST") return await postCollection(req, res, session);
}
