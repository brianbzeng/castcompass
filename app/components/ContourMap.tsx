"use client";

import { useEffect, useRef, useState } from "react";
import type { FeatureCollection, Point } from "geojson";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  StyleSpecification,
} from "maplibre-gl";
import type { FishingSite, OpportunityWindow } from "../types";
import { LocateIcon } from "./icons";

const BAY_AREA_BOUNDS: [[number, number], [number, number]] = [
  [-123.06, 37.34],
  [-121.93, 38.18],
];

const BAY_AREA_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-123.25, 37.18],
  [-121.72, 38.35],
];

const BAY_FIT_OPTIONS = {
  padding: { top: 58, right: 58, bottom: 58, left: 58 },
  maxZoom: 9.35,
  retainPadding: false,
};

const SITE_SOURCE_ID = "fishing-sites";
const CLUSTER_LAYER_ID = "site-clusters";
const CLUSTER_LABEL_LAYER_ID = "site-cluster-labels";
const SITE_LAYER_ID = "site-points";
const SITE_LABEL_LAYER_ID = "site-score-labels";
const USER_SOURCE_ID = "user-position";

const EMPTY_POINTS: FeatureCollection<Point> = {
  type: "FeatureCollection",
  features: [],
};

const ARCGIS_ATTRIBUTION =
  'Powered by <a href="https://www.esri.com/" target="_blank">Esri</a> | Sources: Esri, GEBCO, NOAA, National Geographic, Garmin, TomTom, and other contributors';

const ARCGIS_OCEAN_STYLE: StyleSpecification = {
  version: 8,
  name: "ArcGIS World Ocean",
  glyphs:
    "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf",
  sources: {
    "arcgis-ocean-base": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 16,
      attribution: ARCGIS_ATTRIBUTION,
    },
    "arcgis-ocean-reference": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 16,
    },
  },
  layers: [
    {
      id: "arcgis-ocean-base",
      type: "raster",
      source: "arcgis-ocean-base",
      paint: { "raster-fade-duration": 0 },
    },
    {
      id: "arcgis-ocean-reference",
      type: "raster",
      source: "arcgis-ocean-reference",
      paint: { "raster-fade-duration": 0 },
    },
  ],
};

interface ContourMapProps {
  sites: FishingSite[];
  windowsBySite: Map<string, OpportunityWindow>;
  selectedSiteId: string | null;
  onSelectSite: (siteId: string) => void;
  userPosition: [number, number] | null;
}

function siteFeatureCollection(
  sites: FishingSite[],
  windowsBySite: Map<string, OpportunityWindow>,
  selectedSiteId: string | null,
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: sites.map((site) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [site.longitude, site.latitude],
      },
      properties: {
        siteId: site.id,
        score: Math.round(windowsBySite.get(site.id)?.score ?? 0),
        selected: site.id === selectedSiteId ? 1 : 0,
      },
    })),
  };
}

function userFeatureCollection(userPosition: [number, number] | null): FeatureCollection<Point> {
  if (!userPosition) return EMPTY_POINTS;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: userPosition },
        properties: {},
      },
    ],
  };
}

function addFishingSiteLayers(map: MapLibreMap) {
  map.addSource(SITE_SOURCE_ID, {
    type: "geojson",
    data: EMPTY_POINTS,
    cluster: true,
    clusterMaxZoom: 12,
    clusterRadius: 34,
  });

  map.addLayer({
    id: CLUSTER_LAYER_ID,
    type: "circle",
    source: SITE_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#0c4b6a",
      "circle-opacity": 0.96,
      "circle-radius": ["step", ["get", "point_count"], 20, 5, 23, 10, 27],
      "circle-stroke-color": "#f8fbfc",
      "circle-stroke-width": 2,
    },
  });

  map.addLayer({
    id: CLUSTER_LABEL_LAYER_ID,
    type: "symbol",
    source: SITE_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["to-string", ["get", "point_count_abbreviated"]],
      "text-font": ["Arial Unicode MS Regular"],
      "text-size": 12,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#f8fbfc",
    },
  });

  map.addLayer({
    id: SITE_LAYER_ID,
    type: "circle",
    source: SITE_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": [
        "step",
        ["to-number", ["get", "score"]],
        "#a9b1aa",
        45,
        "#e8d8a6",
        65,
        "#9fd8e5",
        80,
        "#d8ed94",
      ],
      "circle-opacity": 0.98,
      "circle-radius": ["case", ["==", ["get", "selected"], 1], 23, 20],
      "circle-stroke-color": [
        "case",
        ["==", ["get", "selected"], 1],
        "#0b2636",
        "#f8fbfc",
      ],
      "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 4, 2],
    },
  });

  map.addLayer({
    id: SITE_LABEL_LAYER_ID,
    type: "symbol",
    source: SITE_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["to-string", ["get", "score"]],
      "text-font": ["Arial Unicode MS Regular"],
      "text-size": 12,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#061b2b",
    },
  });
}

function addUserPositionLayer(map: MapLibreMap) {
  map.addSource(USER_SOURCE_ID, {
    type: "geojson",
    data: EMPTY_POINTS,
  });

  map.addLayer({
    id: "user-position-halo",
    type: "circle",
    source: USER_SOURCE_ID,
    paint: {
      "circle-color": "#4a9dff",
      "circle-opacity": 0.2,
      "circle-radius": 15,
    },
  });

  map.addLayer({
    id: "user-position-dot",
    type: "circle",
    source: USER_SOURCE_ID,
    paint: {
      "circle-color": "#4a9dff",
      "circle-radius": 7,
      "circle-stroke-color": "#f8fbfc",
      "circle-stroke-width": 3,
    },
  });
}

export function ContourMap({
  sites,
  windowsBySite,
  selectedSiteId,
  onSelectSite,
  userPosition,
}: ContourMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectSiteRef = useRef(onSelectSite);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    onSelectSiteRef.current = onSelectSite;
  }, [onSelectSite]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let active = true;
    let resizeObserver: ResizeObserver | null = null;

    void import("maplibre-gl").then(({ default: maplibregl }) => {
      if (!active || !containerRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: ARCGIS_OCEAN_STYLE,
        bounds: BAY_AREA_BOUNDS,
        fitBoundsOptions: { ...BAY_FIT_OPTIONS, duration: 0 },
        maxBounds: BAY_AREA_MAX_BOUNDS,
        minZoom: 7.2,
        maxZoom: 16,
        maxPitch: 0,
        renderWorldCopies: false,
        attributionControl: false,
        cooperativeGestures: true,
        scrollZoom: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });

      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      mapRef.current = map;

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => map.resize());
        resizeObserver.observe(containerRef.current);
      }

      map.once("load", () => {
        if (!active) return;
        addFishingSiteLayers(map);
        addUserPositionLayer(map);

        map.on("click", SITE_LAYER_ID, (event: MapLayerMouseEvent) => {
          const siteId = event.features?.[0]?.properties?.siteId;
          if (typeof siteId === "string") onSelectSiteRef.current(siteId);
        });

        map.on("click", CLUSTER_LAYER_ID, (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0];
          const clusterId = Number(feature?.properties?.cluster_id);
          if (!feature || feature.geometry.type !== "Point" || !Number.isFinite(clusterId)) return;

          const [longitude, latitude] = feature.geometry.coordinates;
          const source = map.getSource(SITE_SOURCE_ID) as GeoJSONSource | undefined;
          if (!source) return;

          void source.getClusterExpansionZoom(clusterId).then((zoom) => {
            if (!active) return;
            map.easeTo({
              center: [longitude, latitude],
              zoom: Math.min(zoom, map.getMaxZoom()),
              duration: 450,
            });
          });
        });

        const showPointer = () => {
          map.getCanvas().style.cursor = "pointer";
        };
        const clearPointer = () => {
          map.getCanvas().style.cursor = "";
        };
        map.on("mouseenter", SITE_LAYER_ID, showPointer);
        map.on("mouseleave", SITE_LAYER_ID, clearPointer);
        map.on("mouseenter", CLUSTER_LAYER_ID, showPointer);
        map.on("mouseleave", CLUSTER_LAYER_ID, clearPointer);

        setMapReady(true);
      });
    });

    return () => {
      active = false;
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const source = mapRef.current.getSource(SITE_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(siteFeatureCollection(sites, windowsBySite, selectedSiteId));
  }, [sites, windowsBySite, selectedSiteId, mapReady]);

  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const source = mapRef.current.getSource(USER_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(userFeatureCollection(userPosition));
  }, [userPosition, mapReady]);

  const centerBay = () => {
    const map = mapRef.current;
    if (!map) return;
    map.stop();
    map.resize();
    map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
    map.fitBounds(BAY_AREA_BOUNDS, { ...BAY_FIT_OPTIONS, duration: 650 });
  };

  return (
    <div className="contour-map-shell">
      <div ref={containerRef} className="contour-map" aria-label="Map of fishing access locations" />
      <button className="map-center-button" type="button" onClick={centerBay}>
        <LocateIcon /> Center Bay
      </button>
    </div>
  );
}
