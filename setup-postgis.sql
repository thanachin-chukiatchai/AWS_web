\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS public.community_areas (
    community_area SMALLINT PRIMARY KEY CHECK (community_area BETWEEN 1 AND 77),
    name TEXT NOT NULL,
    geom geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_areas_geom
    ON public.community_areas USING GIST (geom);
