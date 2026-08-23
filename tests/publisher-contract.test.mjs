import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publisherErrors } from "../scripts/release-sync.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publisher = JSON.parse(readFileSync(join(root, "publisher", "publisher.json"), "utf8"));
const repository = "https://github.com/Openly-Useful/project-status";

test("publisher mirror records the formation-pending one-entity boundary without transferring RunGlance", () => {
  assert.deepEqual(publisherErrors(publisher), []);
  assert.equal(publisher.displayName, "Openly Useful");
  assert.equal(publisher.legal.plannedName, "Openly Useful LLC");
  assert.equal(publisher.legal.status, "formation-pending");
  assert.deepEqual([...publisher.legal.plannedRoles].sort(), ["licensee", "operator", "publisher"]);
  assert.deepEqual(publisher.repositoryContext.runGlanceCopyright, {
    authorshipStatus: "sole-author-confirmed",
    ownerType: "individual-founder",
    ownershipStatus: "personal",
    transferRequired: false,
  });
  assert.equal(publisher.repositoryContext.currentOpenSourcePublication, "founder-authorized");
  assert.equal(publisher.repositoryContext.futureEntityPublishing, "documentation-pending-after-formation");
  assert.equal(publisher.publication.externalPublicationAllowed, false);
  assert.equal(publisher.publication.authorization, "withheld");
});

test("publisher and component metadata use reachable public endpoints and the routed contact", () => {
  assert.equal(publisher.contacts.public, "hello@openlyuseful.org");
  assert.deepEqual(publisher.repositoryContext.repositories, {
    projectStatus: repository,
    runGlance: repository,
  });
  assert.equal(publisher.policies.support, "https://openlyuseful.org/support");
  assert.equal(publisher.policies.security, "https://openlyuseful.org/security");

  for (const product of ["project-status", "runglance"]) {
    const metadata = JSON.parse(readFileSync(join(root, "skill", product, "assets", "package-metadata.json"), "utf8"));
    assert.equal(metadata.name, product);
    assert.equal(metadata.author.name, "Openly Useful");
    assert.equal(metadata.author.email, "hello@openlyuseful.org");
    assert.equal(metadata.homepage, repository);
    assert.equal(metadata.repository, repository);
    assert.equal(metadata.license, "Apache-2.0");
    assert.equal(metadata.privacy, publisher.policies.privacy);
    assert.equal(metadata.terms, publisher.policies.terms);
    assert.equal(metadata.security, publisher.policies.security);
    assert.equal(metadata.support, publisher.policies.support);
    assert.equal(metadata.publisherManifest, publisher.authorityManifest);
    assert.equal(metadata.openai.interface.developerName, "Openly Useful");
  }
});

test("publisher validator rejects an ownership transfer or premature entity authorization claim", () => {
  const transferred = structuredClone(publisher);
  transferred.repositoryContext.runGlanceCopyright.transferRequired = true;
  assert.match(publisherErrors(transferred).join("\n"), /transferRequired must be false/);

  const premature = structuredClone(publisher);
  premature.repositoryContext.futureEntityPublishing = "founder-authorized-license";
  assert.match(publisherErrors(premature).join("\n"), /future entity publishing authorization/);
});

test("LICENSE is the exact Apache License 2.0 reference text", () => {
  const digest = createHash("sha256").update(readFileSync(join(root, "LICENSE"))).digest("hex");
  assert.equal(digest, "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4");
});
