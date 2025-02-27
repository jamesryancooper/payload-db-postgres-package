import type { DrizzleSnapshotJSON } from 'drizzle-kit/payload'
import type { Payload, PayloadRequestWithData } from 'payload'

import { sql } from 'drizzle-orm'
import fs from 'fs'
import { createRequire } from 'module'
import { buildVersionCollectionFields, buildVersionGlobalFields } from 'payload'
import toSnakeCase from 'to-snake-case'

import type { PostgresAdapter } from '../../types.js'
import type { PathsToQuery } from './types.js'

import { groupUpSQLStatements } from './groupUpSQLStatements.js'
import { migrateRelationships } from './migrateRelationships.js'
import { traverseFields } from './traverseFields.js'

const require = createRequire(import.meta.url)

type Args = {
  debug?: boolean
  payload: Payload
  req?: Partial<PayloadRequestWithData>
}

/**
 * Moves upload and relationship columns from the join table and into the tables while moving data
 * This is done in the following order:
 *    ADD COLUMNs
 *    -- manipulate data to move relationships to new columns
 *    ADD CONSTRAINTs
 *    NOT NULLs
 *    DROP TABLEs
 *    DROP CONSTRAINTs
 *    DROP COLUMNs
 * @param debug
 * @param payload
 * @param req
 */
export const migratePostgresV2toV3 = async ({ debug, payload, req }: Args) => {
  const adapter = payload.db as PostgresAdapter
  const db = adapter.sessions[req.transactionID]?.db
  const dir = payload.db.migrationDir

  // get the drizzle migrateUpSQL from drizzle using the last schema
  const { generateDrizzleJson, generateMigration } = require('drizzle-kit/payload')
  const drizzleJsonAfter = generateDrizzleJson(adapter.schema)

  // Get the previous migration snapshot
  const previousSnapshot = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json') && !file.endsWith('relationships_v2_v3.json'))
    .sort()
    .reverse()?.[0]

  if (!previousSnapshot) {
    throw new Error(
      `No previous migration schema file found! A prior migration from v2 is required to migrate to v3.`,
    )
  }

  const drizzleJsonBefore = JSON.parse(
    fs.readFileSync(`${dir}/${previousSnapshot}`, 'utf8'),
  ) as DrizzleSnapshotJSON

  const generatedSQL = await generateMigration(drizzleJsonBefore, drizzleJsonAfter)

  if (!generatedSQL.length) {
    payload.logger.info(`No schema changes needed.`)
    process.exit(0)
  }

  const sqlUpStatements = groupUpSQLStatements(generatedSQL)

  const addColumnsStatement = sqlUpStatements.addColumn.join('\n')

  if (debug) {
    payload.logger.info('CREATING NEW RELATIONSHIP COLUMNS')
    payload.logger.info(addColumnsStatement)
  }

  await db.execute(sql.raw(addColumnsStatement))

  for (const collection of payload.config.collections) {
    const tableName = adapter.tableNameMap.get(toSnakeCase(collection.slug))
    const pathsToQuery: PathsToQuery = new Set()

    traverseFields({
      adapter,
      collectionSlug: collection.slug,
      columnPrefix: '',
      db,
      disableNotNull: false,
      fields: collection.fields,
      isVersions: false,
      newTableName: tableName,
      parentTableName: tableName,
      path: '',
      pathsToQuery,
      payload,
      rootTableName: tableName,
    })

    await migrateRelationships({
      adapter,
      collectionSlug: collection.slug,
      db,
      debug,
      fields: collection.fields,
      isVersions: false,
      pathsToQuery,
      payload,
      req,
      tableName,
    })

    if (collection.versions) {
      const versionsTableName = adapter.tableNameMap.get(
        `_${toSnakeCase(collection.slug)}${adapter.versionsSuffix}`,
      )
      const versionFields = buildVersionCollectionFields(collection)
      const versionPathsToQuery: PathsToQuery = new Set()

      traverseFields({
        adapter,
        collectionSlug: collection.slug,
        columnPrefix: '',
        db,
        disableNotNull: true,
        fields: versionFields,
        isVersions: true,
        newTableName: versionsTableName,
        parentTableName: versionsTableName,
        path: '',
        pathsToQuery: versionPathsToQuery,
        payload,
        rootTableName: versionsTableName,
      })

      await migrateRelationships({
        adapter,
        collectionSlug: collection.slug,
        db,
        debug,
        fields: versionFields,
        isVersions: true,
        pathsToQuery: versionPathsToQuery,
        payload,
        req,
        tableName: versionsTableName,
      })
    }
  }

  for (const global of payload.config.globals) {
    const tableName = adapter.tableNameMap.get(toSnakeCase(global.slug))

    const pathsToQuery: PathsToQuery = new Set()

    traverseFields({
      adapter,
      columnPrefix: '',
      db,
      disableNotNull: false,
      fields: global.fields,
      globalSlug: global.slug,
      isVersions: false,
      newTableName: tableName,
      parentTableName: tableName,
      path: '',
      pathsToQuery,
      payload,
      rootTableName: tableName,
    })

    await migrateRelationships({
      adapter,
      db,
      debug,
      fields: global.fields,
      globalSlug: global.slug,
      isVersions: false,
      pathsToQuery,
      payload,
      req,
      tableName,
    })

    if (global.versions) {
      const versionsTableName = adapter.tableNameMap.get(
        `_${toSnakeCase(global.slug)}${adapter.versionsSuffix}`,
      )

      const versionFields = buildVersionGlobalFields(global)

      const versionPathsToQuery: PathsToQuery = new Set()

      traverseFields({
        adapter,
        columnPrefix: '',
        db,
        disableNotNull: true,
        fields: versionFields,
        globalSlug: global.slug,
        isVersions: true,
        newTableName: versionsTableName,
        parentTableName: versionsTableName,
        path: '',
        pathsToQuery: versionPathsToQuery,
        payload,
        rootTableName: versionsTableName,
      })

      await migrateRelationships({
        adapter,
        db,
        debug,
        fields: versionFields,
        globalSlug: global.slug,
        isVersions: true,
        pathsToQuery: versionPathsToQuery,
        payload,
        req,
        tableName: versionsTableName,
      })
    }
  }

  // ADD CONSTRAINT
  const addConstraintsStatement = sqlUpStatements.addConstraint.join('\n')

  if (debug) {
    payload.logger.info('ADDING CONSTRAINTS')
    payload.logger.info(addConstraintsStatement)
  }

  await db.execute(sql.raw(addConstraintsStatement))

  // NOT NULL
  const notNullStatements = sqlUpStatements.notNull.join('\n')

  if (debug) {
    payload.logger.info('NOT NULL CONSTRAINTS')
    payload.logger.info(notNullStatements)
  }

  await db.execute(sql.raw(notNullStatements))

  // DROP TABLE
  const dropTablesStatement = sqlUpStatements.dropTable.join('\n')

  if (debug) {
    payload.logger.info('DROPPING TABLES')
    payload.logger.info(dropTablesStatement)
  }

  await db.execute(sql.raw(dropTablesStatement))

  // DROP CONSTRAINT
  const dropConstraintsStatement = sqlUpStatements.dropConstraint.join('\n')

  if (debug) {
    payload.logger.info('DROPPING CONSTRAINTS')
    payload.logger.info(dropConstraintsStatement)
  }

  await db.execute(sql.raw(dropConstraintsStatement))

  // DROP COLUMN
  const dropColumnsStatement = sqlUpStatements.dropColumn.join('\n')

  if (debug) {
    payload.logger.info('DROPPING COLUMNS')
    payload.logger.info(dropColumnsStatement)
  }

  await db.execute(sql.raw(dropColumnsStatement))
}
