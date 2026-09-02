// backend/src/modules/locations/location.controller.ts
import { Request, Response } from "express";
import prisma from "../../lib/prisma";

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  country?: string;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address?: NominatimAddress;
}

interface NominatimReverseResult {
  display_name: string;
  address?: NominatimAddress;
}

const normalizeSuggestionQuery = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

async function fetchFromNominatim(query: string): Promise<NominatimResult[]> {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=10&addressdetails=1`
  );
  const data = await response.json();
  return data as NominatimResult[];
}

export const searchLocations = async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== "string" || q.trim().length < 2) {
      return res.status(200).json({ success: true, data: [] });
    }

    const query = normalizeSuggestionQuery(q);
    if (!query) {
      return res.status(200).json({ success: true, data: [] });
    }

    const terms = query.split(" ").filter(Boolean).slice(0, 6);
    const searchNeedles = Array.from(new Set([query, ...terms]));

    const properties = await prisma.property.findMany({
      where: {
        OR: searchNeedles.flatMap((term) => [
          { location: { contains: term, mode: "insensitive" } },
          { title: { contains: term, mode: "insensitive" } },
        ]),
        deletedAt: null,
        approvalStatus: "approved",
        isAvailable: true,
      },
      select: {
        id: true,
        location: true,
        latitude: true,
        longitude: true,
        title: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    let locations: any[] = properties.map((prop) => {
      const parts = prop.location.split(",").map((part) => part.trim()).filter(Boolean);
      return {
        id: `property:${prop.id}`,
        type: "property",
        name: prop.title,
        city: parts[0] || prop.location,
        country: parts.slice(1).join(", "),
        latitude: prop.latitude,
        longitude: prop.longitude,
      };
    });

    try {
      const results = locations.length < 8 ? await fetchFromNominatim(query) : [];
      const externalLocations = results.map((result: NominatimResult) => ({
        id: `osm:${result.place_id.toString()}`,
        type: "location",
        name: result.display_name.split(",")[0],
        city: result.address?.city || result.address?.town || result.address?.village || "",
        country: result.address?.country || "",
        latitude: parseFloat(result.lat),
        longitude: parseFloat(result.lon),
        display_name: result.display_name,
      }));

      const seenLabels = new Set(
        locations.map((location) => `${location.name}|${location.city}`.toLowerCase())
      );
      for (const externalLocation of externalLocations) {
        const label = `${externalLocation.name}|${externalLocation.city}`.toLowerCase();
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          locations.push(externalLocation);
        }
        if (locations.length >= 10) break;
      }
    } catch {
      // Local property suggestions are enough when the external geocoder is unavailable.
    }

    if (locations.length === 0) {
      const distinctLocations = await prisma.property.findMany({
        where: {
          location: { contains: query, mode: "insensitive" },
          deletedAt: null,
          approvalStatus: "approved",
          isAvailable: true,
        },
        select: {
          location: true,
          latitude: true,
          longitude: true,
        },
        distinct: ["location"],
        take: 10,
      });

      locations = distinctLocations.map((prop) => {
        const parts = prop.location.split(",").map((part) => part.trim());
        return {
          id: prop.location,
          type: "location",
          name: parts[0] || prop.location,
          city: parts[1] || "",
          country: parts[2] || "",
          latitude: prop.latitude,
          longitude: prop.longitude,
        };
      });
    }

    res.status(200).json({ success: true, data: locations });
  } catch (error: any) {
    console.error("Error searching locations:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to search locations",
    });
  }
};

export const getLocationByCoordinates = async (req: Request, res: Response) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: "Latitude and longitude are required" });
    }

    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
    );
    const data = await response.json() as NominatimReverseResult;

    res.status(200).json({
      success: true,
      data: {
        address: data.display_name,
        city: data.address?.city || data.address?.town || data.address?.village,
        country: data.address?.country,
      },
    });
  } catch (error: any) {
    console.error("Error getting location by coordinates:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
