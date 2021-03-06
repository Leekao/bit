/** @flow */
import path from 'path';
import semver from 'semver';
import groupArray from 'group-array';
import fs from 'fs-extra';
import R from 'ramda';
import chalk from 'chalk';
import format from 'string-format';
import partition from 'lodash.partition';
import { locateConsumer, pathHasConsumer, pathHasBitMap } from './consumer-locator';
import { ConsumerAlreadyExists, ConsumerNotFound, NothingToImport, MissingDependencies } from './exceptions';
import { Driver } from '../driver';
import DriverNotFound from '../driver/exceptions/driver-not-found';
import ConsumerBitJson from './bit-json/consumer-bit-json';
import { BitId, BitIds } from '../bit-id';
import Component from './component';
import {
  BITS_DIRNAME,
  BIT_HIDDEN_DIR,
  COMPONENT_ORIGINS,
  BIT_VERSION,
  NODE_PATH_SEPARATOR,
  LATEST_BIT_VERSION
} from '../constants';
import { Scope, ComponentWithDependencies } from '../scope';
import migratonManifest from './migrations/consumer-migrator-manifest';
import migrate, { ConsumerMigrationResult } from './migrations/consumer-migrator';
import enrichContextFromGlobal from '../hooks/utils/enrich-context-from-global';
import loader from '../cli/loader';
import { BEFORE_IMPORT_ACTION, BEFORE_INSTALL_NPM_DEPENDENCIES, BEFORE_MIGRATION } from '../cli/loader/loader-messages';
import BitMap from './bit-map/bit-map';
import { MissingBitMapComponent } from './bit-map/exceptions';
import logger from '../logger/logger';
import DirStructure from './dir-structure/dir-structure';
import { getLatestVersionNumber, filterAsync, pathNormalizeToLinux } from '../utils';
import loadDependenciesForComponent from './component/dependencies-resolver';
import { Version, Component as ModelComponent } from '../scope/models';
import MissingFilesFromComponent from './component/exceptions/missing-files-from-component';
import ComponentNotFoundInPath from './component/exceptions/component-not-found-in-path';
import npmClient from '../npm-client';
import { RemovedLocalObjects } from '../scope/component-remove';
import { linkComponents, linkAllToNodeModules } from '../links';
import * as packageJson from './component/package-json';

export type ConsumerProps = {
  projectPath: string,
  created?: boolean,
  bitJson: ConsumerBitJson,
  scope: Scope
};

type ComponentStatus = {
  modified: boolean,
  newlyCreated: boolean,
  deleted: boolean,
  staged: boolean,
  notExist: boolean
};

export default class Consumer {
  projectPath: string;
  created: boolean;
  bitJson: ConsumerBitJson;
  scope: Scope;
  _driver: Driver;
  _bitMap: BitMap;
  _dirStructure: DirStructure;
  _componentsCache: Object = {}; // cache loaded components
  _componentsStatusCache: Object = {}; // cache loaded components

  constructor({ projectPath, bitJson, scope, created = false }: ConsumerProps) {
    this.projectPath = projectPath;
    this.bitJson = bitJson;
    this.created = created;
    this.scope = scope;
    this.warnForMissingDriver();
  }

  get testerId(): ?BitId {
    return BitId.parse(this.bitJson.testerId);
  }

  get compilerId(): ?BitId {
    return BitId.parse(this.bitJson.compilerId);
  }

  get driver(): Driver {
    if (!this._driver) {
      this._driver = Driver.load(this.bitJson.lang);
    }
    return this._driver;
  }

  get dirStructure(): DirStructure {
    if (!this._dirStructure) {
      this._dirStructure = new DirStructure(
        this.bitJson.componentsDefaultDirectory,
        this.bitJson.dependenciesDirectory
      );
    }
    return this._dirStructure;
  }

  async getBitMap(): Promise<BitMap> {
    if (!this._bitMap) {
      this._bitMap = await BitMap.load(this.getPath());
    }
    return this._bitMap;
  }

  /**
   * Check if the driver installed and print message if not
   *
   *
   * @param {any} msg msg to print in case the driver not found (use string-format with the err context)
   * @returns {boolean} true if the driver exists, false otherwise
   * @memberof Consumer
   */
  warnForMissingDriver(msg: string): boolean {
    try {
      this.driver.getDriver(false);
      return true;
    } catch (err) {
      msg = msg
        ? format(msg, err)
        : `Warning: Bit is not be able to run the link command. Please install bit-${
          err.lang
        } driver and run the link command.`;
      if (err instanceof DriverNotFound) {
        console.log(chalk.yellow(msg)); // eslint-disable-line
      }
      return false;
    }
  }

  /**
   * Running migration process for consumer to update the stores (.bit.map.json) to the current version
   *
   * @param {any} verbose - print debug logs
   * @returns {Object} - wether the process run and wether it successeded
   * @memberof Consumer
   */
  async migrate(verbose): Object {
    logger.debug('running migration process for consumer');
    // Check version of stores (bitmap / bitjson) to check if we need to run migrate
    // If migration is needed add loader - loader.start(BEFORE_MIGRATION);
    // bitmap migrate
    if (verbose) console.log('running migration process for consumer'); // eslint-disable-line
    // We start to use this process after version 0.10.9, so we assume the scope is in the last production version
    const bitMap = await this.getBitMap();
    const bitmapVersion = bitMap.version || '0.10.9';

    if (semver.gte(bitmapVersion, BIT_VERSION)) {
      logger.debug('bit.map version is up to date');
      return {
        run: false
      };
    }

    loader.start(BEFORE_MIGRATION);

    const result: ConsumerMigrationResult = await migrate(bitmapVersion, migratonManifest, bitMap, verbose);
    result.bitMap.version = BIT_VERSION;
    await result.bitMap.write();

    return {
      run: true,
      success: true
    };
  }

  write(): Promise<Consumer> {
    return this.bitJson
      .write({ bitDir: this.projectPath })
      .then(() => this.scope.ensureDir())
      .then(() => this);
  }

  getComponentsPath(): string {
    return path.join(this.projectPath, BITS_DIRNAME);
  }

  getPath(): string {
    return this.projectPath;
  }

  getPathRelativeToConsumer(pathToCheck: string): string {
    const absolutePath = path.resolve(pathToCheck);
    return path.relative(this.getPath(), absolutePath);
  }

  async loadComponent(id: BitId): Promise<Component> {
    const { components } = await this.loadComponents([id]);
    return components[0];
  }

  async loadComponents(
    ids: BitId[],
    throwOnFailure: boolean = true
  ): Promise<{ components: Component[], deletedComponents: BitId[] }> {
    logger.debug(`loading consumer-components from the file-system, ids: ${ids.join(', ')}`);
    const alreadyLoadedComponents = [];
    const idsToProcess = [];
    const deletedComponents = [];
    ids.forEach((id) => {
      if (this._componentsCache[id.toString()]) {
        logger.debug(`the component ${id.toString()} has been already loaded, use the cached component`);
        alreadyLoadedComponents.push(this._componentsCache[id.toString()]);
      } else {
        idsToProcess.push(id);
      }
    });
    if (!idsToProcess.length) return { components: alreadyLoadedComponents, deletedComponents };

    const bitMap: BitMap = await this.getBitMap();

    const driverExists = this.warnForMissingDriver(
      'Warning: Bit is not be able calculate the dependencies tree. Please install bit-{lang} driver and run commit again.'
    );

    const components = idsToProcess.map(async (id: BitId) => {
      const idWithConcreteVersionString = getLatestVersionNumber(Object.keys(bitMap.getAllComponents()), id.toString());
      const idWithConcreteVersion = BitId.parse(idWithConcreteVersionString);

      const componentMap = bitMap.getComponent(idWithConcreteVersion, true);
      let bitDir = this.getPath();
      if (componentMap.rootDir) {
        bitDir = path.join(bitDir, componentMap.rootDir);
      }
      const componentFromModel = await this.scope.getFromLocalIfExist(idWithConcreteVersion);
      let component;
      try {
        component = await Component.loadFromFileSystem({
          bitDir,
          consumerBitJson: this.bitJson,
          componentMap,
          id: idWithConcreteVersion,
          consumerPath: this.getPath(),
          bitMap,
          componentFromModel
        });
      } catch (err) {
        if (throwOnFailure) throw err;

        logger.error(`failed loading ${id} from the file-system`);
        if (err instanceof MissingFilesFromComponent || err instanceof ComponentNotFoundInPath) {
          deletedComponents.push(id);
          return null;
        }
        throw err;
      }
      component.originallySharedDir = componentMap.originallySharedDir || null;

      if (!driverExists || componentMap.origin === COMPONENT_ORIGINS.NESTED) {
        // no need to resolve dependencies
        return component;
      }
      return loadDependenciesForComponent(
        component,
        componentMap,
        bitDir,
        this,
        bitMap,
        idWithConcreteVersionString,
        componentFromModel
      );
    });

    const allComponents = [];
    for (const componentP of components) {
      // load the components one after another (not in parallel).
      const component = await componentP;
      if (component) {
        this._componentsCache[component.id.toString()] = component;
        logger.debug(`Finished loading the component, ${component.id.toString()}`);
        allComponents.push(component);
      }
    }
    if (bitMap.hasChanged) await bitMap.write();

    return { components: allComponents.concat(alreadyLoadedComponents), deletedComponents };
  }

  async importAccordingToBitJsonAndBitMap(
    verbose?: boolean,
    withEnvironments: ?boolean,
    cache?: boolean = true,
    withPackageJson?: boolean = true,
    force?: boolean = false,
    dist?: boolean = false,
    conf?: boolean = false,
    installNpmPackages?: boolean = true,
    saveDependenciesAsComponents?: boolean = false
  ): Promise<> {
    const dependenciesFromBitJson = BitIds.fromObject(this.bitJson.dependencies);
    const bitMap = await this.getBitMap();
    const componentsFromBitMap = bitMap.getAuthoredExportedComponents();

    if ((R.isNil(dependenciesFromBitJson) || R.isEmpty(dependenciesFromBitJson)) && R.isEmpty(componentsFromBitMap)) {
      if (!withEnvironments) {
        return Promise.reject(new NothingToImport());
      } else if (R.isNil(this.testerId) && R.isNil(this.compilerId)) {
        return Promise.reject(new NothingToImport());
      }
    }
    if (!force) {
      const allComponentsIds = dependenciesFromBitJson.concat(componentsFromBitMap);
      await this.warnForModifiedComponents(allComponentsIds);
    }

    let componentsAndDependenciesBitJson = [];
    let componentsAndDependenciesBitMap = [];
    if (dependenciesFromBitJson) {
      componentsAndDependenciesBitJson = await this.scope.getManyWithAllVersions(dependenciesFromBitJson, cache);
      await this.writeToComponentsDir({
        componentsWithDependencies: componentsAndDependenciesBitJson,
        withPackageJson,
        withBitJson: conf,
        dist,
        saveDependenciesAsComponents,
        installNpmPackages,
        verbose
      });
    }
    if (componentsFromBitMap.length) {
      componentsAndDependenciesBitMap = await this.scope.getManyWithAllVersions(componentsFromBitMap, cache);
      // Don't write the package.json for an authored component, because its dependencies probably managed by the root
      // package.json. Also, don't install npm packages for the same reason.
      await this.writeToComponentsDir({
        componentsWithDependencies: componentsAndDependenciesBitMap,
        force: false,
        withPackageJson: false,
        installNpmPackages: false,
        withBitJson: conf,
        dist
      });
    }
    const componentsAndDependencies = [...componentsAndDependenciesBitJson, ...componentsAndDependenciesBitMap];
    if (withEnvironments) {
      const envComponents = await this.scope.installEnvironment({
        ids: [this.testerId, this.compilerId],
        verbose
      });
      return {
        dependencies: componentsAndDependencies,
        envDependencies: envComponents
      };
    }
    return { dependencies: componentsAndDependencies };
  }

  async warnForModifiedComponents(ids: BitId[]) {
    const modifiedComponents = await filterAsync(ids, (id) => {
      return this.getComponentStatusById(id).then(status => status.modified);
    });

    if (modifiedComponents.length) {
      return Promise.reject(
        chalk.yellow(
          `unable to import the following components due to local changes, use --force flag to override your local changes\n${modifiedComponents.join(
            '\n'
          )} `
        )
      );
    }
    return Promise.resolve();
  }

  async importSpecificComponents(
    rawIds: ?(string[]),
    cache?: boolean,
    writeToPath?: string,
    withPackageJson?: boolean = true,
    writeBitDependencies?: boolean = false,
    force?: boolean = false,
    verbose?: boolean = false,
    dist?: boolean = false,
    conf?: boolean = false,
    installNpmPackages?: boolean = true,
    saveDependenciesAsComponents?: boolean = false
  ) {
    logger.debug(`importSpecificComponents, Ids: ${rawIds.join(', ')}`);
    // $FlowFixMe - we check if there are bitIds before we call this function
    const bitIds = rawIds.map(raw => BitId.parse(raw));
    if (!force) {
      await this.warnForModifiedComponents(bitIds);
    }
    const componentsWithDependencies = await this.scope.getManyWithAllVersions(bitIds, cache);
    await this.writeToComponentsDir({
      componentsWithDependencies,
      writeToPath,
      withPackageJson,
      withBitJson: conf,
      writeBitDependencies,
      dist,
      saveDependenciesAsComponents,
      installNpmPackages,
      verbose
    });
    return { dependencies: componentsWithDependencies };
  }

  import(
    rawIds: ?(string[]),
    verbose?: boolean,
    withEnvironments: ?boolean,
    cache?: boolean = true,
    writeToPath?: string,
    withPackageJson?: boolean = true,
    writeBitDependencies?: boolean = false,
    force?: boolean = false,
    dist?: boolean = false,
    conf?: boolean = false,
    installNpmPackages?: boolean = true
  ): Promise<{ dependencies: ComponentWithDependencies[], envDependencies?: Component[] }> {
    loader.start(BEFORE_IMPORT_ACTION);
    let saveDependenciesAsComponents = this.bitJson.saveDependenciesAsComponents;
    if (!withPackageJson) {
      // if package.json is not written, it's impossible to install the packages and dependencies as npm packages
      installNpmPackages = false;
      saveDependenciesAsComponents = true;
    }
    if (!rawIds || R.isEmpty(rawIds)) {
      return this.importAccordingToBitJsonAndBitMap(
        verbose,
        withEnvironments,
        cache,
        withPackageJson,
        force,
        dist,
        conf,
        installNpmPackages,
        saveDependenciesAsComponents
      );
    }
    return this.importSpecificComponents(
      rawIds,
      cache,
      writeToPath,
      withPackageJson,
      writeBitDependencies,
      force,
      verbose,
      dist,
      conf,
      installNpmPackages,
      saveDependenciesAsComponents
    );
  }

  importEnvironment(rawId: ?string, verbose?: boolean) {
    if (!rawId) {
      throw new Error('you must specify bit id for importing');
    } // @TODO - make a normal error message
    const bitId = BitId.parse(rawId);
    return this.scope.installEnvironment({ ids: [bitId], verbose }).then((envDependencies) => {
      // todo: do we need the environment in bit.map?
      // this.bitMap.addComponent(bitId.toString(), this.composeRelativeBitPath(bitId));
      // this.bitMap.write();
      return envDependencies;
    });
  }

  removeFromComponents(id: BitId, currentVersionOnly: boolean = false): Promise<any> {
    const componentsDir = this.getComponentsPath();
    const componentDir = path.join(componentsDir, id.box, id.name, id.scope, currentVersionOnly ? id.version : '');

    return new Promise((resolve, reject) => {
      return fs.remove(componentDir, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });
  }

  /**
   * write the components into '/components' dir (or according to the bit.map) and its dependencies in the
   * '/components/.dependencies' dir. Both directories are configurable in bit.json
   * For example: global/a has a dependency my-scope/global/b@1. The directories will be:
   * project/root/components/global/a/impl.js
   * project/root/components/.dependencies/global/b/my-scope/1/impl.js
   *
   * In case there are some same dependencies shared between the components, it makes sure to
   * write them only once.
   */
  async writeToComponentsDir({
    componentsWithDependencies,
    writeToPath,
    force = true,
    withPackageJson = true,
    withBitJson = true,
    writeBitDependencies = false,
    createNpmLinkFiles = false,
    dist = true,
    saveDependenciesAsComponents = false,
    installNpmPackages = true,
    addToRootPackageJson = true,
    verbose = false,
    excludeRegistryPrefix = false
  }: {
    componentsWithDependencies: ComponentWithDependencies[],
    writeToPath?: string,
    force?: boolean,
    withPackageJson?: boolean,
    withBitJson?: boolean,
    writeBitDependencies?: boolean,
    createNpmLinkFiles?: boolean,
    dist?: boolean,
    saveDependenciesAsComponents?: boolean, // as opposed to npm packages
    installNpmPackages?: boolean,
    addToRootPackageJson?: boolean,
    verbose?: boolean,
    excludeRegistryPrefix?: boolean
  }): Promise<Component[]> {
    const bitMap: BitMap = await this.getBitMap();
    const dependenciesIdsCache = [];
    const remotes = await this.scope.remotes();
    const writeComponentsP = componentsWithDependencies.map((componentWithDeps: ComponentWithDependencies) => {
      const bitDir = writeToPath || this.composeComponentPath(componentWithDeps.component.id);
      componentWithDeps.component.writtenPath = bitDir;
      // if a component.scope is listed as a remote, it doesn't go to the hub and therefore it can't import dependencies as packages
      componentWithDeps.component.dependenciesSavedAsComponents =
        saveDependenciesAsComponents || remotes.get(componentWithDeps.component.scope);
      // AUTHORED and IMPORTED components can't be saved with multiple versions, so we can ignore the version to
      // find the component in bit.map
      const componentMap = bitMap.getComponent(componentWithDeps.component.id.toStringWithoutVersion(), false);
      const origin =
        componentMap && componentMap.origin === COMPONENT_ORIGINS.AUTHORED
          ? COMPONENT_ORIGINS.AUTHORED
          : COMPONENT_ORIGINS.IMPORTED;
      if (origin === COMPONENT_ORIGINS.IMPORTED) {
        componentWithDeps.component.stripOriginallySharedDir(bitMap);
      }
      // don't write dists files for authored components as the author has its own mechanism to generate them
      // also, don't write dists file for imported component, unless the user used '--dist' flag
      componentWithDeps.component._writeDistsFiles = dist && origin === COMPONENT_ORIGINS.IMPORTED;
      return componentWithDeps.component.write({
        bitDir,
        force,
        bitMap,
        withBitJson,
        withPackageJson,
        origin,
        consumer: this,
        writeBitDependencies: writeBitDependencies || !componentWithDeps.component.dependenciesSavedAsComponents, // when dependencies are written as npm packages, they must be written in package.json
        componentMap,
        excludeRegistryPrefix
      });
    });
    const writtenComponents = await Promise.all(writeComponentsP);

    const allDependenciesP = componentsWithDependencies.map((componentWithDeps: ComponentWithDependencies) => {
      if (!componentWithDeps.component.dependenciesSavedAsComponents) return Promise.resolve(null);
      const writeDependenciesP = componentWithDeps.dependencies.map((dep: Component) => {
        const dependencyId = dep.id.toString();
        const depFromBitMap = bitMap.getComponent(dependencyId, false);
        if (depFromBitMap && fs.existsSync(depFromBitMap.rootDir)) {
          dep.writtenPath = depFromBitMap.rootDir;
          logger.debug(
            `writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in bit map and file system`
          );
          bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        if (dependenciesIdsCache[dependencyId]) {
          logger.debug(`writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in cache`);
          dep.writtenPath = dependenciesIdsCache[dependencyId];
          bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        const depBitPath = this.composeDependencyPath(dep.id);
        dep.writtenPath = depBitPath;
        dependenciesIdsCache[dependencyId] = depBitPath;
        // When a component is NESTED we do interested in the exact version, because multiple components with the same scope
        // and namespace can co-exist with different versions.
        const componentMap = bitMap.getComponent(dep.id.toString(), false);
        return dep.write({
          bitDir: depBitPath,
          force,
          bitMap,
          withPackageJson,
          origin: COMPONENT_ORIGINS.NESTED,
          parent: componentWithDeps.component.id,
          consumer: this,
          componentMap,
          excludeRegistryPrefix
        });
      });

      return Promise.all(writeDependenciesP);
    });
    const writtenDependenciesIncludesNull = await Promise.all(allDependenciesP);
    const writtenDependencies = writtenDependenciesIncludesNull.filter(dep => dep);
    if (writeToPath) {
      componentsWithDependencies.forEach((componentWithDeps) => {
        const relativeWrittenPath = this.getPathRelativeToConsumer(componentWithDeps.component.writtenPath);
        if (relativeWrittenPath && path.resolve(relativeWrittenPath) !== path.resolve(writeToPath)) {
          const component = componentWithDeps.component;
          this.moveExistingComponent(bitMap, component, relativeWrittenPath, writeToPath);
        }
      });
    }

    // add workspaces if flag is true
    await packageJson.addWorkspacesToPackageJson(
      this,
      this.getPath(),
      this.bitJson.componentsDefaultDirectory,
      this.bitJson.dependenciesDirectory,
      writeToPath
    );

    await bitMap.write();
    if (installNpmPackages) await this.installNpmPackagesForComponents(componentsWithDependencies, verbose);
    if (addToRootPackageJson) await packageJson.addComponentsToRoot(this, writtenComponents, bitMap);

    return linkComponents(
      componentsWithDependencies,
      writtenComponents,
      writtenDependencies,
      bitMap,
      this,
      createNpmLinkFiles
    );
  }

  moveExistingComponent(bitMap: BitMap, component: Component, oldPath: string, newPath: string) {
    if (fs.existsSync(newPath)) {
      throw new Error(
        `could not move the component ${
          component.id
        } from ${oldPath} to ${newPath} as the destination path already exists`
      );
    }
    const componentMap = bitMap.getComponent(component.id);
    componentMap.updateDirLocation(oldPath, newPath);
    fs.moveSync(oldPath, newPath);
    component.writtenPath = newPath;
  }

  /**
   * By default, the dists paths are inside the component.
   * If dist attribute is populated in bit.json, the paths are in consumer-root/dist-target.
   */
  shouldDistsBeInsideTheComponent(): boolean {
    return !this.bitJson.distEntry && !this.bitJson.distTarget;
  }

  async candidateComponentsForAutoTagging(modifiedComponents: BitId[]) {
    const bitMap = await this.getBitMap();
    const candidateComponents = bitMap.getAllComponents([COMPONENT_ORIGINS.AUTHORED, COMPONENT_ORIGINS.IMPORTED]);
    if (!candidateComponents) return null;
    const modifiedComponentsWithoutVersions = modifiedComponents.map(modifiedComponent =>
      modifiedComponent.toStringWithoutVersion()
    );
    const candidateComponentsIds = Object.keys(candidateComponents).map(id => BitId.parse(id));
    // if a modified component is in candidates array, remove it from the array as it will be already tagged with the
    // correct version
    return candidateComponentsIds.filter(
      component => !modifiedComponentsWithoutVersions.includes(component.toStringWithoutVersion())
    );
  }

  async listComponentsForAutoTagging(modifiedComponents: BitId[]) {
    const candidateComponents = await this.candidateComponentsForAutoTagging(modifiedComponents);
    return this.scope.bumpDependenciesVersions(candidateComponents, modifiedComponents, false);
  }

  async bumpDependenciesVersions(committedComponents: Component[]) {
    const committedComponentsIds = committedComponents.map(committedComponent => committedComponent.id);
    const candidateComponents = await this.candidateComponentsForAutoTagging(committedComponentsIds);
    return this.scope.bumpDependenciesVersions(candidateComponents, committedComponentsIds, true);
  }

  /**
   * Check whether a model representation and file-system representation of the same component is the same.
   * The way how it is done is by converting the file-system representation of the component into
   * a Version object. Once this is done, we have two Version objects, and we can compare their hashes
   */
  async isComponentModified(componentFromModel: Version, componentFromFileSystem: Component): boolean {
    if (typeof componentFromFileSystem._isModified === 'undefined') {
      const bitMap = await this.getBitMap();
      const componentMap = bitMap.getComponent(componentFromFileSystem.id, true);
      if (componentMap.originallySharedDir) {
        componentFromFileSystem.originallySharedDir = componentMap.originallySharedDir;
      }
      const { version } = await this.scope.sources.consumerComponentToVersion({
        consumerComponent: componentFromFileSystem
      });

      version.log = componentFromModel.log; // ignore the log, it's irrelevant for the comparison

      // sometime dependencies from the FS don't have an exact version, copy the version from the model
      version.dependencies.forEach((dependency) => {
        if (!dependency.id.hasVersion()) {
          const idWithoutVersion = dependency.id.toStringWithoutVersion();
          const dependencyFromModel = componentFromModel.dependencies.find(
            modelDependency => modelDependency.id.toStringWithoutVersion() === idWithoutVersion
          );
          if (dependencyFromModel) {
            dependency.id = dependencyFromModel.id;
          }
        }
      });

      /*
        sort packageDependencies for comparing
       */
      const sortObject = (obj) => {
        return Object.keys(obj)
          .sort()
          .reduce(function (result, key) {
            result[key] = obj[key];
            return result;
          }, {});
      };
      version.packageDependencies = sortObject(version.packageDependencies);
      componentFromModel.packageDependencies = sortObject(componentFromModel.packageDependencies);
      // uncomment to easily understand why two components are considered as modified
      // if (componentFromModel.hash().hash !== version.hash().hash) {
      //   console.log('-------------------componentFromModel------------------------');
      //   console.log(componentFromModel.id());
      //   console.log('------------------------version------------------------------');
      //   console.log(version.id());
      //   console.log('-------------------------END---------------------------------');
      // }
      componentFromFileSystem._isModified = componentFromModel.hash().hash !== version.hash().hash;
    }
    return componentFromFileSystem._isModified;
  }

  /**
   * Get a component status by ID. Return a ComponentStatus object.
   * Keep in mind that a result can be a partial object of ComponentStatus, e.g. { notExist: true }.
   * Each one of the ComponentStatus properties can be undefined, true or false.
   * As a result, in order to check whether a component is not modified use (status.modified === false).
   * Don't use (!status.modified) because a component may not exist and the status.modified will be undefined.
   *
   * The status may have 'true' for several properties. For example, a component can be staged and modified at the
   * same time.
   *
   * The result is cached per ID and can be called several times with no penalties.
   */
  async getComponentStatusById(id: BitId): Promise<ComponentStatus> {
    const getStatus = async () => {
      const status: ComponentStatus = {};
      const componentFromModel: ModelComponent = await this.scope.sources.get(id);
      let componentFromFileSystem;
      try {
        componentFromFileSystem = await this.loadComponent(BitId.parse(id.toStringWithoutVersion()));
      } catch (err) {
        if (
          err instanceof MissingFilesFromComponent ||
          err instanceof ComponentNotFoundInPath ||
          err instanceof MissingBitMapComponent
        ) {
          // the file/s have been deleted or the component doesn't exist in bit.map file
          if (componentFromModel) status.deleted = true;
          else status.notExist = true;
          return status;
        }
        throw err;
      }
      if (!componentFromModel) {
        status.newlyCreated = true;
        return status;
      }
      // "!componentFromModel.scope" is for backward compatibility, and won't be needed for components created since v0.11.3.
      status.staged = componentFromModel.local || !componentFromModel.scope;
      const versionFromFs = componentFromFileSystem.id.version;
      const latestVersionFromModel = componentFromModel.latest();
      // Consider the following two scenarios:
      // 1) a user tagged v1, exported, then tagged v2.
      //    to check whether the component is modified, we've to compare FS to the v2 of the model, not v1.
      // 2) a user imported v1 of a component from a remote, when the latest version on the remote is v2.
      //    to check whether the component is modified, we've to compare FS to the v1 of the model, not v2.
      //    @see reduce-path.e2e 'importing v1 of a component when a component has v2' to reproduce this case.
      const version = status.staged ? latestVersionFromModel : versionFromFs;
      const versionRef = componentFromModel.versions[version];
      const versionFromModel = await this.scope.getObject(versionRef.hash);
      status.modified = await this.isComponentModified(versionFromModel, componentFromFileSystem);
      return status;
    };
    if (!this._componentsStatusCache[id.toString()]) {
      this._componentsStatusCache[id.toString()] = await getStatus();
    }
    return this._componentsStatusCache[id.toString()];
  }

  async commit(
    ids: BitId[],
    message: string,
    exactVersion: ?string,
    releaseType: string,
    force: ?boolean,
    verbose: ?boolean,
    ignoreMissingDependencies: ?boolean
  ): Promise<{ components: Component[], autoUpdatedComponents: ModelComponent[] }> {
    logger.debug(`committing the following components: ${ids.join(', ')}`);
    const componentsIds = ids.map(componentId => BitId.parse(componentId));
    const { components } = await this.loadComponents(componentsIds);
    // Run over the components to check if there is missing dependencies
    // If there is at least one we won't commit anything
    if (!ignoreMissingDependencies) {
      const componentsWithMissingDeps = components.filter((component) => {
        return Boolean(component.missingDependencies);
      });
      if (!R.isEmpty(componentsWithMissingDeps)) throw new MissingDependencies(componentsWithMissingDeps);
    }
    const committedComponents = await this.scope.putMany({
      consumerComponents: components,
      message,
      exactVersion,
      releaseType,
      force,
      consumer: this,
      verbose
    });
    const autoUpdatedComponents = await this.bumpDependenciesVersions(committedComponents);

    return { components, autoUpdatedComponents };
  }

  static getNodeModulesPathOfComponent(bindingPrefix, id) {
    if (!id.scope) throw new Error(`Failed creating a path in node_modules for ${id}, as it does not have a scope yet`);
    // Temp fix to support old components before the migraion has been running
    bindingPrefix = bindingPrefix === 'bit' ? '@bit' : bindingPrefix;
    return path.join('node_modules', bindingPrefix, [id.scope, id.box, id.name].join(NODE_PATH_SEPARATOR));
  }

  static getComponentIdFromNodeModulesPath(requirePath, bindingPrefix) {
    requirePath = pathNormalizeToLinux(requirePath);
    // Temp fix to support old components before the migraion has been running
    bindingPrefix = bindingPrefix === 'bit' ? '@bit' : bindingPrefix;
    const prefix = requirePath.includes('node_modules') ? `node_modules/${bindingPrefix}/` : `${bindingPrefix}/`;
    const withoutPrefix = requirePath.substr(requirePath.indexOf(prefix) + prefix.length);
    const componentName = withoutPrefix.includes('/')
      ? withoutPrefix.substr(0, withoutPrefix.indexOf('/'))
      : withoutPrefix;
    const pathSplit = componentName.split(NODE_PATH_SEPARATOR);
    if (pathSplit.length < 3) throw new Error(`require statement ${requirePath} of the bit component is invalid`);

    const name = pathSplit[pathSplit.length - 1];
    const box = pathSplit[pathSplit.length - 2];
    const scope = pathSplit.length === 3 ? pathSplit[0] : `${pathSplit[0]}.${pathSplit[1]}`;
    return new BitId({ scope, box, name }).toString();
  }

  composeRelativeBitPath(bitId: BitId): string {
    const { componentsDefaultDirectory } = this.dirStructure;
    return format(componentsDefaultDirectory, { name: bitId.name, scope: bitId.scope, namespace: bitId.box });
  }

  composeComponentPath(bitId: BitId): string {
    const addToPath = [this.getPath(), this.composeRelativeBitPath(bitId)];
    logger.debug(`component dir path: ${addToPath.join('/')}`);
    return path.join(...addToPath);
  }

  composeDependencyPath(bitId: BitId): string {
    const dependenciesDir = this.dirStructure.dependenciesDirStructure;
    return path.join(this.getPath(), dependenciesDir, bitId.toFullPath());
  }

  async movePaths({ from, to }: { from: string, to: string }) {
    const fromExists = fs.existsSync(from);
    const toExists = fs.existsSync(to);
    if (fromExists && toExists) {
      throw new Error(`unable to move because both paths from (${from}) and to (${to}) already exist`);
    }
    if (!fromExists && !toExists) throw new Error(`both paths from (${from}) and to (${to}) do not exist`);

    const fromRelative = this.getPathRelativeToConsumer(from);
    const toRelative = this.getPathRelativeToConsumer(to);
    const bitMap = await this.getBitMap();
    const changes = bitMap.updatePathLocation(fromRelative, toRelative, fromExists);
    if (fromExists && !toExists) {
      // user would like to physically move the file. Otherwise (!fromExists and toExists), user would like to only update bit.map
      fs.moveSync(from, to);
    }
    await bitMap.write();
    return changes;
  }

  static create(projectPath: string = process.cwd()): Promise<Consumer> {
    return this.ensure(projectPath);
  }

  static ensure(projectPath: string = process.cwd()): Promise<Consumer> {
    const scopeP = Scope.ensure(path.join(projectPath, BIT_HIDDEN_DIR));
    const bitJsonP = ConsumerBitJson.ensure(projectPath);

    return Promise.all([scopeP, bitJsonP]).then(([scope, bitJson]) => {
      return new Consumer({
        projectPath,
        created: true,
        scope,
        bitJson
      });
    });
  }

  static async createWithExistingScope(consumerPath: string, scope: Scope): Promise<Consumer> {
    if (pathHasConsumer(consumerPath)) return Promise.reject(new ConsumerAlreadyExists());
    const bitJson = await ConsumerBitJson.ensure(consumerPath);
    return new Consumer({
      projectPath: consumerPath,
      created: true,
      scope,
      bitJson
    });
  }

  static async load(currentPath: string, throws: boolean = true): Promise<?Consumer> {
    const projectPath = locateConsumer(currentPath);
    if (!projectPath) {
      if (throws) return Promise.reject(new ConsumerNotFound());
      return Promise.resolve(null);
    }
    if (!pathHasConsumer(projectPath) && pathHasBitMap(projectPath)) {
      await Consumer.create(currentPath).then(consumer => consumer.write());
    }
    const scopeP = Scope.load(path.join(projectPath, BIT_HIDDEN_DIR));
    const bitJsonP = ConsumerBitJson.load(projectPath);
    return Promise.all([scopeP, bitJsonP]).then(
      ([scope, bitJson]) =>
        new Consumer({
          projectPath,
          bitJson,
          scope
        })
    );
  }
  async deprecateRemote(bitIds: Array<BitId>) {
    const groupedBitsByScope = groupArray(bitIds, 'scope');
    const remotes = await this.scope.remotes();
    const context = {};
    enrichContextFromGlobal(context);
    const deprecateP = Object.keys(groupedBitsByScope).map(async (scopeName) => {
      const resolvedRemote = await remotes.resolve(scopeName, this.scope);
      const deprecateResult = await resolvedRemote.deprecateMany(groupedBitsByScope[scopeName], context);
      return deprecateResult;
    });
    const deprecatedComponentsResult = await Promise.all(deprecateP);
    return deprecatedComponentsResult;
  }
  async deprecateLocal(bitIds: Array<BitId>) {
    return this.scope.deprecateMany(bitIds);
  }
  async deprecate(ids: string[], remote: boolean) {
    const bitIds = ids.map(bitId => BitId.parse(bitId));
    return remote ? this.deprecateRemote(bitIds) : this.deprecateLocal(bitIds);
  }

  /**
   * Remove components local and remote
   * splits array of ids into local and remote and removes according to flags
   * @param {string[]} ids - list of remote component ids to delete
   * @param {boolean} force - delete component that are used by other components.
   * @param {boolean} track - keep tracking local staged components in bitmap.
   * @param {boolean} deleteFiles - delete local added files from fs.
   */
  async remove(ids: string[], force: boolean, track: boolean, deleteFiles: boolean) {
    // added this to remove support for remove version
    const bitIds = ids.map(bitId => BitId.parse(bitId)).map((id) => {
      id.version = LATEST_BIT_VERSION;
      return id;
    });
    const [localIds, remoteIds] = partition(bitIds, id => id.isLocal());
    const localResult = await this.removeLocal(localIds, force, track, deleteFiles);
    const remoteResult = await this.removeRemote(remoteIds, force);
    return { localResult, remoteResult };
  }

  /**
   * Remove remote component from ssh server
   * this method groups remote components by remote name and deletes remote components together
   * @param {BitIds} bitIds - list of remote component ids to delete
   * @param {boolean} force - delete component that are used by other components.
   */
  async removeRemote(bitIds: BitIds, force: boolean) {
    const groupedBitsByScope = groupArray(bitIds, 'scope');
    const remotes = await this.scope.remotes();
    const context = {};
    enrichContextFromGlobal(context);
    const removeP = Object.keys(groupedBitsByScope).map(async (key) => {
      const resolvedRemote = await remotes.resolve(key, this.scope);
      return resolvedRemote.deleteMany(groupedBitsByScope[key], force, context);
    });

    return Promise.all(removeP);
  }
  /**
   * delete files from fs according to imported/created
   * @param {BitIds} bitIds - list of remote component ids to delete
   * @param {BitMap} bitMap - delete component that are used by other components.
   * @param {boolean} deleteFiles - delete component that are used by other components.
   */
  async removeComponentFromFs(bitIds: BitIds, bitMap: BitMap, deleteFiles: boolean) {
    return Promise.all(
      bitIds.map(async (id) => {
        const component = id.isLocal()
          ? bitMap.getComponent(bitMap.getExistingComponentId(id.toStringWithoutVersion()))
          : bitMap.getComponent(id);
        if (!component) return;
        if (
          (component.origin && component.origin === COMPONENT_ORIGINS.IMPORTED) ||
          component.origin === COMPONENT_ORIGINS.NESTED
        ) {
          return fs.remove(path.join(this.getPath(), component.rootDir));
        } else if (component.origin === COMPONENT_ORIGINS.AUTHORED && deleteFiles) {
          return Promise.all(component.files.map(file => fs.remove(file.relativePath)));
        }
      })
    );
  }
  /**
   * resolveLocalComponentIds - method is used for resolving local component ids
   * imported = bit.remote/utils/is-string
   * local = utils/is-string
   * if component is imported then cant remove version only component
   * @param {BitIds} bitIds - list of remote component ids to delete
   * @param {BitMap} bitMap - delete component that are used by other components.
   * @param {boolean} deleteFiles - delete component that are used by other components.
   */
  resolveLocalComponentIds(bitIds: BitIds, bitMap: BitMap) {
    return bitIds.map((id) => {
      const realName = bitMap.getExistingComponentId(id.toStringWithoutVersion());
      if (!realName) return id;
      const component = bitMap.getComponent(realName);
      if (
        component &&
        (component.origin === COMPONENT_ORIGINS.IMPORTED || component.origin === COMPONENT_ORIGINS.NESTED)
      ) {
        const realId = BitId.parse(realName);
        realId.version = LATEST_BIT_VERSION;
        return realId;
      }
      if (component) return BitId.parse(realName);
      return id;
    });
  }

  /**
   * cleanBitMapAndBitJson - clean up removed components from bitmap and bit.json file
   * @param {BitMap} bitMap - list of remote component ids to delete
   * @param {BitIds} componensToRemoveFromFs - delete component that are used by other components.
   * @param {BitIds} removedDependencies - delete component that are used by other components.
   */
  async cleanBitMapAndBitJson(bitMap: BitMap, componensToRemoveFromFs: BitIds, removedDependencies: BitIds) {
    const bitJson = this.bitJson;
    bitMap.removeComponents(componensToRemoveFromFs);
    bitMap.removeComponents(removedDependencies);
    componensToRemoveFromFs.map(x => delete bitJson.dependencies[x.toStringWithoutVersion()]);
    bitJson.write({ bitDir: this.projectPath });
    return await bitMap.write();
  }
  /**
   * removeLocal - remove local (imported, new staged components) from modules and bitmap  accoriding to flags
   * @param {BitIds} bitIds - list of remote component ids to delete
   * @param {boolean} force - delete component that are used by other components.
   * @param {boolean} deleteFiles - delete component that are used by other components.
   */
  async removeLocal(bitIds: BitIds, force: boolean, track: boolean, deleteFiles: boolean) {
    // local remove in case user wants to delete commited components
    const bitMap = await this.getBitMap();
    const modifiedComponents = [];
    const regularComponents = [];
    const resolvedIDs = this.resolveLocalComponentIds(bitIds, bitMap);
    if (R.isEmpty(resolvedIDs)) return new RemovedLocalObjects();
    if (!force) {
      await Promise.all(
        resolvedIDs.map(async (id) => {
          const componentStatus = await this.getComponentStatusById(id);
          if (componentStatus.modified) modifiedComponents.push(id);
          else regularComponents.push(id);
        })
      );
    }
    const { removedComponentIds, missingComponents, dependentBits, removedDependencies } = await this.scope.removeMany(
      force ? resolvedIDs : regularComponents,
      force,
      true
    );

    const componensToRemoveFromFs = removedComponentIds.filter(id => id.version === LATEST_BIT_VERSION);
    if (!R.isEmpty(removedComponentIds)) {
      await this.removeComponentFromFs(componensToRemoveFromFs, bitMap, deleteFiles);
      await this.removeComponentFromFs(removedDependencies, bitMap, false);
    }
    if ((!track || deleteFiles) && !R.isEmpty(removedComponentIds)) {
      await this.cleanBitMapAndBitJson(bitMap, componensToRemoveFromFs, removedDependencies);
    }
    return new RemovedLocalObjects(
      removedComponentIds,
      missingComponents,
      modifiedComponents,
      dependentBits,
      removedDependencies
    );
  }

  async addRemoteAndLocalVersionsToDependencies(component: Component, loadedFromFileSystem: boolean) {
    logger.debug(`addRemoteAndLocalVersionsToDependencies for ${component.id.toString()}`);
    let modelDependencies = [];
    if (loadedFromFileSystem) {
      // when loaded from file-system, the dependencies versions are fetched from bit.map.
      // try to find the model version of the component to get the stored versions of the dependencies
      try {
        const mainComponentFromModel = await this.scope.loadRemoteComponent(component.id);
        modelDependencies = mainComponentFromModel.dependencies;
      } catch (e) {
        // do nothing. the component is probably on the file-system only and not on the model.
      }
    }
    const dependenciesIds = component.dependencies.map(dependency => dependency.id);
    const localDependencies = await this.scope.latestVersions(dependenciesIds);
    const remoteVersionsDependencies = await this.scope.fetchRemoteVersions(dependenciesIds);
    component.dependencies.forEach((dependency) => {
      const dependencyIdWithoutVersion = dependency.id.toStringWithoutVersion();
      const removeVersionId = remoteVersionsDependencies.find(
        remoteId => remoteId.toStringWithoutVersion() === dependencyIdWithoutVersion
      );
      const localVersionId = localDependencies.find(
        localId => localId.toStringWithoutVersion() === dependencyIdWithoutVersion
      );
      const modelVersionId = modelDependencies.find(
        modelDependency => modelDependency.id.toStringWithoutVersion() === dependencyIdWithoutVersion
      );
      dependency.remoteVersion = removeVersionId ? removeVersionId.version : null;
      dependency.localVersion = localVersionId ? localVersionId.version : null;
      dependency.currentVersion = modelVersionId ? modelVersionId.id.version : dependency.id.version;
    });
  }

  async _installPackages(dirs: string[], verbose: boolean, installRootPackageJson: boolean = false) {
    const packageManager = this.bitJson.packageManager;
    const packageManagerArgs = this.bitJson.packageManagerArgs;
    const packageManagerProcessOptions = this.bitJson.packageManagerProcessOptions;
    const useWorkspaces = this.bitJson.useWorkspaces;

    loader.start(BEFORE_INSTALL_NPM_DEPENDENCIES);

    // don't pass the packages to npmClient.install function.
    // otherwise, it'll try to npm install the packages in one line 'npm install packageA packageB' and when
    // there are mix of public and private packages it fails with 404 error.
    // passing an empty array, results in installing packages from the package.json file
    let results = await npmClient.install({
      modules: [],
      packageManager,
      packageManagerArgs,
      packageManagerProcessOptions,
      useWorkspaces,
      dirs,
      rootDir: this.getPath(),
      installRootPackageJson,
      verbose
    });

    loader.stop();
    if (!Array.isArray(results)) {
      results = [results];
    }
    results.forEach((result) => {
      if (result) npmClient.printResults(result);
    });
  }

  async installNpmPackagesForComponents(
    componentsWithDependencies: ComponentWithDependencies[],
    verbose: boolean = false
  ): Promise<*> {
    // if dependencies are installed as bit-components, go to each one of the dependencies and install npm packages
    // otherwise, if the dependencies are installed as npm packages, npm already takes care of that
    const componentsWithDependenciesFlatten = R.flatten(
      componentsWithDependencies.map((oneComponentWithDependencies) => {
        return oneComponentWithDependencies.component.dependenciesSavedAsComponents
          ? [oneComponentWithDependencies.component, ...oneComponentWithDependencies.dependencies]
          : [oneComponentWithDependencies.component];
      })
    );

    const componentDirs = componentsWithDependenciesFlatten.map(component => component.writtenPath);
    return this._installPackages(componentDirs, verbose);
  }

  /**
   * does the following (the order is important):
   * 1) install npm packages of the consumer root.
   * 2) install npm packages of all imported and nested components
   * 3) link all components
   */
  async install(verbose) {
    const bitMap = await this.getBitMap();
    const candidateComponents = bitMap.getAllComponents([COMPONENT_ORIGINS.IMPORTED, COMPONENT_ORIGINS.NESTED]);
    const dirs = Object.keys(candidateComponents)
      .map(id => candidateComponents[id].rootDir || null)
      .filter(dir => dir);
    await this._installPackages(dirs, verbose, true);
    return linkAllToNodeModules(this);
  }
}
