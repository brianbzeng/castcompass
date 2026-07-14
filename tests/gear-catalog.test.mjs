import assert from "node:assert/strict";
import test from "node:test";
import { GEAR_CATALOG, findCatalogProduct, gearBrands, gearProducts } from "../app/data/gear-catalog.ts";

test("gear catalog covers broad rod, reel, and lure brand sets", () => {
  assert.ok(gearBrands("rod").length >= 12);
  assert.ok(gearBrands("reel").length >= 8);
  assert.ok(gearBrands("lure").length >= 15);
  assert.ok(GEAR_CATALOG.rod.length > 50);
  assert.ok(GEAR_CATALOG.reel.length > 100);
  assert.ok(GEAR_CATALOG.lure.length > 75);
});

test("dependent Shimano reel catalog includes exact Curado variants", () => {
  const shimano = gearProducts("reel", "Shimano").map((product) => product.label);
  assert.ok(shimano.includes("Shimano Curado DC 200 HG"));
  assert.ok(shimano.includes("Shimano Curado 200M 200HGM"));
  assert.equal(findCatalogProduct("reel", "shimano curado dc 150 xg")?.brand, "Shimano");
});
