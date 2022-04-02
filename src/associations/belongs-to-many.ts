import each from 'lodash/each';
import isPlainObject from 'lodash/isPlainObject';
import omit from 'lodash/omit';
import upperFirst from 'lodash/upperFirst';
import { AssociationError } from '../errors';
import type {
  BulkCreateOptions,
  CreateOptions,
  CreationAttributes,
  Filterable,
  FindAttributeOptions,
  FindOptions,
  InstanceDestroyOptions,
  InstanceUpdateOptions,
  Transactionable,
  ModelStatic,
  Model,
  WhereOptions,
  AttributeNames,
  ModelAttributeColumnOptions,
  Attributes,
  Includeable,
  ModelAttributes,
  UpdateOptions,
  ModelOptions,
} from '../model';
import { isModelStatic } from '../model';
import { Op } from '../operators';
import type { Sequelize } from '../sequelize';
import { col, fn } from '../sequelize';
import type { AllowArray } from '../utils';
import * as Utils from '../utils';
import { assertAssociationModelIsDefined } from './association-utils';
import type { AssociationScope, ForeignKeyOptions, MultiAssociationOptions, MultiAssociationAccessors, AssociationOptions } from './base';
import { MultiAssociation } from './base';
import { BelongsTo } from './belongs-to';
import { HasMany } from './has-many';
import { HasOne } from './has-one';
import * as Helpers from './helpers';
import { AssociationConstructorSecret, removeUndefined } from './helpers';

// TODO: strictly type mixin options
// TODO: compare mixin methods with these methods
// TODO: add typing tests to check that association creation calls with the wrong parameters are caught
// TODO: strongly type the through model

// TODO: add test to ensure 'through' is only used in one association
// TODO: add all necessary "inverse" options
// TODO: write new documentation
// TODO: add all necessary options to configure "fromThroughToSource", "fromSourceToThrough"

// TODO: add tests in belongs-to-many to check the name of foreign key, associations, etc
//  for selfAssociations
//  for others

function addInclude(findOptions: FindOptions<any>, include: Includeable) {
  if (Array.isArray(findOptions.include)) {
    findOptions.include.push(include);
  } else if (!findOptions.include) {
    findOptions.include = [include];
  } else {
    findOptions.include = [findOptions.include, include];
  }
}

/**
 * Many-to-many association with a join/through table.
 * See {@link Model.belongsToMany}
 *
 * When the join table has additional attributes, these can be passed in the options object:
 *
 * ```js
 * UserProject = sequelize.define('user_project', {
 *   role: Sequelize.STRING
 * });
 * User.belongsToMany(Project, { through: UserProject });
 * Project.belongsToMany(User, { through: UserProject });
 * // through is required!
 *
 * user.addProject(project, { through: { role: 'manager' }});
 * ```
 *
 * All methods allow you to pass either a persisted instance, its primary key, or a mixture:
 *
 * ```js
 * const project = await Project.create({ id: 11 });
 * await user.addProjects([project, 12]);
 * ```
 *
 * If you want to set several target instances, but with different attributes you have to set the attributes on the instance, using a property with the name of the through model:
 *
 * ```js
 * p1.UserProjects = {
 *   started: true
 * }
 * user.setProjects([p1, p2], { through: { started: false }}) // The default value is false, but p1 overrides that.
 * ```
 *
 * Similarly, when fetching through a join table with custom attributes, these attributes will be available as an object with the name of the through model.
 * ```js
 * const projects = await user.getProjects();
 * const p1 = projects[0];
 * p1.UserProjects.started // Is this project started yet?
 * ```
 *
 * In the API reference below, add the name of the association to the method, e.g. for `User.belongsToMany(Project)` the getter will be `user.getProjects()`.
 */
export class BelongsToMany<
  SourceModel extends Model = Model,
  TargetModel extends Model = Model,
  ThroughModel extends Model = Model,
  SourceKey extends AttributeNames<SourceModel> = any,
  TargetKey extends AttributeNames<TargetModel> = any,
> extends MultiAssociation<
  SourceModel,
  TargetModel,
  /* ForeignKey */ string,
  TargetKey,
  NormalizedBelongsToManyOptions<SourceKey, TargetKey, ThroughModel>
> {
  readonly associationType = 'BelongsToMany';

  /**
   * The options, as they were when passed to the constructor.
   *
   * @internal
   * @private
   */
  readonly _originalOptions: BelongsToManyOptions<SourceKey, TargetKey, ThroughModel>;

  readonly accessors: MultiAssociationAccessors;

  primaryKeyDeleted: boolean = false;

  /**
   * The name of the Foreign Key attribute, located on the through table, that points to the Target model.
   *
   * Not to be confused with @link {BelongsToMany.foreignKey}, which points to the Source model instead.
   *
   * @type {string}
   */
  // '!' added because this is initialized in constructor through a function call
  get otherKey() {
    return this.pairedWith.foreignKey;
  }

  // '!' added because this is initialized in constructor through a function call
  get otherKeyAttribute() {
    return this.pairedWith.foreignKeyAttribute;
  }

  /**
   * @deprecated use {@link BelongsToMany#foreignKey}
   */
  get identifier() {
    return this.foreignKey;
  }

  /**
   * The corresponding column name of {@link BelongsToMany#foreignKey}
   */
  readonly identifierField: string;

  /**
   * @deprecated use {@link BelongsToMany#otherKey}
   */
  get foreignIdentifier() {
    return this.otherKey;
  }

  /**
   * The corresponding column name of {@link BelongsToMany#otherKey}
   */
  get foreignIdentifierField() {
    return this.pairedWith.identifierField;
  }

  /**
   * The name of the Attribute that the {@link foreignKey} fk (located on the Through Model) will reference on the Source model.
   */
  get sourceKey(): SourceKey {
    return this.attributeReferencedByForeignKey as SourceKey;
  }

  /**
   * The name of the Column that the {@link foreignKey} fk (located on the Through Table) will reference on the Source model.
   */
  readonly sourceKeyField: string;

  /**
   * The name of the Attribute that the {@link otherKey} fk (located on the Through Model) will reference on the Target model.
   */
  get targetKey(): TargetKey {
    return this.pairedWith.sourceKey;
  }

  /**
   * The name of the Column that the {@link otherKey} fk (located on the Through Table) will reference on the Target model.
   */
  get targetKeyField(): string {
    return this.pairedWith.sourceKeyField;
  }

  /**
   * The corresponding association this entity is paired with.
   */
  readonly pairedWith: BelongsToMany<TargetModel, SourceModel, ThroughModel, TargetKey, SourceKey>;

  // intermediary associations
  // these create the actual associations on the model. Remove them would be a breaking change.
  readonly fromSourceToThrough: HasMany<SourceModel, ThroughModel, SourceKey, any>;
  readonly fromSourceToThroughOne: HasOne<SourceModel, ThroughModel, SourceKey, any>;
  readonly fromThroughToSource: BelongsTo<ThroughModel, SourceModel, any, SourceKey>;
  get fromTargetToThrough(): HasMany<TargetModel, ThroughModel, TargetKey, any> {
    return this.pairedWith.fromSourceToThrough;
  }

  get fromTargetToThroughOne(): HasOne<TargetModel, ThroughModel, TargetKey, any> {
    return this.pairedWith.fromSourceToThroughOne;
  }

  get fromThroughToTarget(): BelongsTo<ThroughModel, TargetModel, any, TargetKey> {
    return this.pairedWith.fromThroughToSource;
  }

  constructor(
    secret: symbol,
    source: ModelStatic<SourceModel>,
    target: ModelStatic<TargetModel>,
    options: BelongsToManyOptions<SourceKey, TargetKey, ThroughModel>,
    pair?: BelongsToMany<TargetModel, SourceModel, ThroughModel, TargetKey, SourceKey>,
  ) {
    if (!options || (typeof options.through !== 'string' && !isPlainObject(options.through) && !isModelStatic(options.through))) {
      throw new AssociationError(`${source.name}.belongsToMany(${target.name}) requires through option, pass either a string or a model`);
    }

    assertAssociationModelIsDefined(source);
    assertAssociationModelIsDefined(target);

    const sequelize = source.sequelize!;

    const attributeReferencedByForeignKey = options?.sourceKey || source.primaryKeyAttribute as SourceKey;

    super(secret, source, target, attributeReferencedByForeignKey, {
      ...options,
      // though is either a string of a Model. Convert it to ThroughOptions.
      through: isThroughOptions(options.through)
        ? normalizeThroughOptions(options.through, sequelize)
        : normalizeThroughOptions({ model: options.through }, sequelize),
    });

    this._originalOptions = removeUndefined(options);

    // options.as instead of this.as, because this.as is always set
    if (this.isSelfAssociation) {
      if (!options.as) {
        throw new AssociationError('\'as\' must be defined for many-to-many self-associations');
      }

      if (!options.inverse?.as) {
        throw new AssociationError('\'inverse.as\' must be defined for many-to-many self-associations');
      }
    }

    this.pairedWith = pair ?? new BelongsToMany<TargetModel, SourceModel, ThroughModel, TargetKey, SourceKey>(
      secret,
      target,
      source,
      {
        ...options,
        // note: we can't just use '...options.inverse' because we need to set to underfined if the option wasn't set
        as: options.inverse?.as,
        onDelete: options.inverse?.onDelete,
        onUpdate: options.inverse?.onUpdate,
        inverse: {
          onDelete: options.onDelete,
          onUpdate: options.onUpdate,
          as: options.as,
        },
        sourceKey: options.targetKey,
        targetKey: options.sourceKey,
        foreignKey: options.otherKey,
        otherKey: options.foreignKey,
      },
      this,
    );

    if (!pair) {
      this.pairedWith.parentAssociation = this;
    }

    // computeForeignKey needs this.pairedWith to be created (see inferForeignKey)
    this.computeForeignKey();

    /*
    * Default/generated source/target keys
    */
    this.sourceKeyField = Utils.getColumnName(this.source.rawAttributes[this.sourceKey]);

    // remove any PKs previously defined by sequelize
    // but ignore any keys that are part of this association (#5865)
    each(this.through.model.rawAttributes, (attribute, attributeName) => {
      if (attribute.primaryKey === true && attribute._autoGenerated === true) {
        if ([this.foreignKey, this.otherKey].includes(attributeName)) {
          // this key is still needed as it's part of the association
          // so just set primaryKey to false
          attribute.primaryKey = false;
        } else {
          delete this.through.model.rawAttributes[attributeName];
        }

        this.primaryKeyDeleted = true;
      }
    });

    const sourceKey = this.source.rawAttributes[this.sourceKey];
    const sourceKeyType = sourceKey.type;
    const sourceKeyField = this.sourceKeyField;
    const sourceAttribute: ModelAttributeColumnOptions = { type: sourceKeyType, ...this.foreignKeyAttribute };

    if (this.primaryKeyDeleted) {
      sourceAttribute.primaryKey = true;
    } else if (this.through.unique !== false) {
      let uniqueKey;
      if (typeof this.options.uniqueKey === 'string' && this.options.uniqueKey !== '') {
        uniqueKey = this.options.uniqueKey;
      } else {
        uniqueKey = [this.through.model.tableName, this.foreignKey, this.otherKey, 'unique'].join('_');
      }

      sourceAttribute.unique = uniqueKey;
    }

    if (!this.through.model.rawAttributes[this.foreignKey]) {
      sourceAttribute._autoGenerated = true;
    }

    if (this.options.constraints !== false) {
      sourceAttribute.references = {
        model: this.source.getTableName(),
        key: sourceKeyField,
      };

      // For the source attribute the passed option is the priority
      sourceAttribute.onDelete = this.options.onDelete || this.through.model.rawAttributes[this.foreignKey]?.onDelete || 'CASCADE';
      sourceAttribute.onUpdate = this.options.onUpdate || this.through.model.rawAttributes[this.foreignKey]?.onUpdate || 'CASCADE';
    }

    this.through.model.mergeAttributesOverwrite({
      [this.foreignKey]: sourceAttribute,
    });

    this.identifierField = Utils.getColumnName(this.through.model.rawAttributes[this.foreignKey]);

    // For Db2 server, a reference column of a FOREIGN KEY must be unique
    // else, server throws SQL0573N error. Hence, setting it here explicitly
    // for non primary columns.
    if (this.sequelize.options.dialect === 'db2' && this.source.getAttributes()[this.sourceKey].primaryKey !== true) {
      // TODO: throw instead!
      this.source.getAttributes()[this.sourceKey].unique = true;
    }

    this.fromSourceToThrough = new HasMany(AssociationConstructorSecret, this.source, this.through.model, {
      // @ts-expect-error
      foreignKey: this.foreignKey,
      as: this.isSelfAssociation
        ? `${this.name.plural}_${this.pairedWith.name.plural}`
        : undefined,
    });
    this.fromSourceToThrough.parentAssociation = this;

    this.fromSourceToThroughOne = new HasOne(AssociationConstructorSecret, this.source, this.through.model, {
      // @ts-expect-error
      foreignKey: this.foreignKey,
      sourceKey: this.sourceKey,
      as: this.isSelfAssociation
        ? `${this.name.singular}_${this.pairedWith.name.singular}`
        : this.through.model.options.name.singular,
    });
    this.fromSourceToThroughOne.parentAssociation = this;

    this.fromThroughToSource = new BelongsTo(AssociationConstructorSecret, this.through.model, this.source, {
      // @ts-expect-error
      foreignKey: this.foreignKey,
      as: Utils.singularize(this.pairedWith.as),
    });
    this.fromThroughToSource.parentAssociation = this;

    Helpers.checkNamingCollision(this);

    // Get singular and plural names, trying to uppercase the first letter, unless the model forbids it
    const plural = upperFirst(this.options.name.plural);
    const singular = upperFirst(this.options.name.singular);

    this.accessors = {
      get: `get${plural}`,
      set: `set${plural}`,
      addMultiple: `add${plural}`,
      add: `add${singular}`,
      create: `create${singular}`,
      remove: `remove${singular}`,
      removeMultiple: `remove${plural}`,
      hasSingle: `has${singular}`,
      hasAll: `has${plural}`,
      count: `count${plural}`,
    };

    this.#mixin(source.prototype);
  }

  get sequelize(): Sequelize {
    return this.source.sequelize!;
  }

  get through(): NormalizedThroughOptions<ThroughModel> {
    return this.options.through;
  }

  get throughModel(): ModelStatic<ThroughModel> {
    return this.through.model;
  }

  protected inferForeignKey() {
    if (this.isSelfAssociation) {
      return Utils.camelize(`${this.pairedWith.name.singular}_${this.attributeReferencedByForeignKey}`);
    }

    return Utils.camelize(`${this.source.options.name.singular}_${this.attributeReferencedByForeignKey}`);
  }

  #mixin(modelPrototype: Model) {

    Helpers.mixinMethods(
      this,
      modelPrototype,
      ['get', 'count', 'hasSingle', 'hasAll', 'set', 'add', 'addMultiple', 'remove', 'removeMultiple', 'create'],
      {
        hasSingle: 'has',
        hasAll: 'has',
        addMultiple: 'add',
        removeMultiple: 'remove',
      },
    );
  }

  /**
   * Get everything currently associated with this, using an optional where clause.
   *
   * See {@link Model} for a full explanation of options
   *
   * @param instance instance
   * @param options find options
   */
  async get(instance: SourceModel, options?: BelongsToManyGetAssociationsMixinOptions): Promise<TargetModel[]> {
    const through = this.through;

    const findOptions: FindOptions<Attributes<TargetModel>> = {
      ...options,
      // TODO: current WhereOptions typings do not allow having 'WhereOptions' inside another 'WhereOptions'
      // @ts-expect-error
      where: {
        [Op.and]: [
          options?.where,
          this.scope,
        ],
      },
    };

    let throughWhere = {
      [this.foreignKey]: instance.get(this.sourceKey),
    };

    // TODO: scopes should be joined using Op.and
    if (through.scope) {
      Object.assign(throughWhere, through.scope);
    }

    // If a user pass a where on the options through options, make an "and" with the current throughWhere
    if (options?.through?.where) {
      throughWhere = {
        [Op.and]: [throughWhere, options.through.where],
      };
    }

    addInclude(findOptions, {
      association: this.fromTargetToThroughOne,
      attributes: options?.joinTableAttributes,
      required: true,
      paranoid: options?.through?.paranoid ?? true,
      where: throughWhere,
    });

    let model = this.target;
    if (options?.scope != null) {
      if (!options.scope) {
        model = model.unscoped();
      } else if (options.scope !== true) { // 'true' means default scope. Which is the same as not doing anything.
        model = model.scope(options.scope);
      }
    }

    if (options?.schema) {
      model = model.schema(options.schema, options.schemaDelimiter);
    }

    return model.findAll(findOptions);
  }

  /**
   * Count everything currently associated with this, using an optional where clause.
   *
   * @param instance instance
   * @param options find options
   */
  async count(instance: SourceModel, options?: BelongsToManyCountAssociationsMixinOptions): Promise<number> {
    const getOptions: BelongsToManyGetAssociationsMixinOptions = {
      ...options,
      attributes: [
        [fn('COUNT', col([this.target.name, this.targetKeyField].join('.'))), 'count'],
      ],
      joinTableAttributes: [],
      raw: true,
      plain: true,
    };

    const result = await this.get(instance, getOptions);

    // @ts-expect-error -- this.get() isn't designed to expect returning a raw output.
    return Number.parseInt(result.count, 10);
  }

  /**
   * Check if one or more instance(s) are associated with this. If a list of instances is passed, the function returns true if _all_ instances are associated
   *
   * @param sourceInstance source instance to check for an association with
   * @param targetInstancesOrPks Can be an array of instances or their primary keys
   * @param options Options passed to getAssociations
   */
  async has(
    sourceInstance: SourceModel,
    targetInstancesOrPks: AllowArray<TargetModel | Exclude<TargetModel[TargetKey], any[]>>,
    options?: BelongsToManyHasAssociationMixinOptions,
  ): Promise<boolean> {
    if (!Array.isArray(targetInstancesOrPks)) {
      targetInstancesOrPks = [targetInstancesOrPks];
    }

    const targetPrimaryKeys: Array<TargetModel[TargetKey]> = targetInstancesOrPks.map(instance => {
      if (instance instanceof this.target) {
        return (instance as TargetModel).get(this.targetKey);
      }

      return instance as TargetModel[TargetKey];
    });

    const associatedObjects: TargetModel[] = await this.get(sourceInstance, {
      ...options,
      raw: true,
      scope: false,
      attributes: [this.targetKey],
      joinTableAttributes: [],
      // TODO: current WhereOptions typings do not allow having 'WhereOptions' inside another 'WhereOptions'
      // @ts-expect-error
      where: {
        [Op.and]: [
          { [this.targetKey]: { [Op.in]: targetPrimaryKeys } },
          options?.where,
        ],
      },
    });

    return targetPrimaryKeys.every(pk => {
      return associatedObjects.some(instance => {
        // instance[x] instead of instance.get() because the query output is 'raw'
        return instance[this.targetKey] === pk;
      });
    });
  }

  /**
   * Set the associated models by passing an array of instances or their primary keys.
   * Everything that it not in the passed array will be un-associated.
   *
   * @param sourceInstance source instance to associate new instances with
   * @param newInstancesOrPrimaryKeys A single instance or primary key, or a mixed array of persisted instances or primary keys
   * @param options Options passed to `through.findAll`, `bulkCreate`, `update` and `destroy`
   */
  async set(
    sourceInstance: SourceModel,
    newInstancesOrPrimaryKeys: AllowArray<TargetModel | Exclude<TargetModel[TargetKey], any[]>>,
    options: BelongsToManySetAssociationsMixinOptions = {},
  ): Promise<void> {
    const sourceKey = this.sourceKey;
    const targetKey = this.targetKey;
    const identifier = this.identifier;
    const foreignIdentifier = this.foreignIdentifier;

    const newInstances = newInstancesOrPrimaryKeys === null ? [] : this.toInstanceArray(newInstancesOrPrimaryKeys);

    // TODO: scopes should be joined using Op.and
    const where = {
      [identifier]: sourceInstance.get(sourceKey),
      ...this.through.scope,
    };

    const currentThroughRows: ThroughModel[] = await this.through.model.findAll({
      ...options,
      where,
      raw: true,
      // force this option to be false, in case the user enabled
      rejectOnEmpty: false,
    });

    const obsoleteTargets: Array<TargetModel | Exclude<TargetModel[TargetKey], any[]>> = [];

    // find all obsolete targets
    for (const currentRow of currentThroughRows) {
      const newTarget = newInstances.find(obj => {
        // @ts-expect-error -- the findAll call is raw, no model here
        return currentRow[foreignIdentifier] === obj.get(targetKey);
      });

      if (!newTarget) {
        // @ts-expect-error -- the findAll call is raw, no model here
        obsoleteTargets.push(currentRow[this.foreignIdentifier]);
      }
    }

    const promises: Array<Promise<any>> = [];
    if (obsoleteTargets.length > 0) {
      promises.push(this.remove(sourceInstance, obsoleteTargets, options));
    }

    if (newInstances.length > 0) {
      promises.push(this.#updateAssociations(sourceInstance, currentThroughRows, newInstances, options));
    }

    await Promise.all(promises);
  }

  /**
   * Associate one or several rows with source instance. It will not un-associate any already associated instance
   * that may be missing from `newInstances`.
   *
   * @param sourceInstance source instance to associate new instances with
   * @param newInstancesOrPrimaryKeys A single instance or primary key, or a mixed array of persisted instances or primary keys
   * @param options Options passed to `through.findAll`, `bulkCreate` and `update`
   */
  async add(
    sourceInstance: SourceModel,
    newInstancesOrPrimaryKeys: AllowArray<TargetModel | Exclude<TargetModel[TargetKey], any[]>>,
    options?: BelongsToManyAddAssociationsMixinOptions,
  ): Promise<void> {
    // If newInstances is null or undefined, no-op
    if (!newInstancesOrPrimaryKeys) {
      return;
    }

    const newInstances = this.toInstanceArray(newInstancesOrPrimaryKeys);

    const currentRows = await this.through.model.findAll({
      ...options,
      raw: true,
      where: {
        [this.identifier]: sourceInstance.get(this.sourceKey),
        [this.foreignIdentifier]: newInstances.map(newInstance => newInstance.get(this.targetKey)),
        // TODO: scopes should be joined using Op.and
        ...this.through.scope,
      },
      // force this option to be false, in case the user enabled
      rejectOnEmpty: false,
    });

    await this.#updateAssociations(sourceInstance, currentRows, newInstances, options);
  }

  /**
   * Adds new target instances that were not already present in the through table.
   * Updates the through table row of the instances that already were present.
   *
   * @param sourceInstance
   * @param currentThroughRows
   * @param newTargets
   * @param options
   * @private
   */
  async #updateAssociations(
    sourceInstance: SourceModel,
    currentThroughRows: ThroughModel[],
    newTargets: TargetModel[],
    options?:
      & { through?: JoinTableAttributes }
      & BulkCreateOptions<Attributes<ThroughModel>>
      & Omit<UpdateOptions<Attributes<ThroughModel>>, 'where'>,
  ) {
    const sourceKey = this.sourceKey;
    const targetKey = this.targetKey;
    const identifier = this.identifier;
    const foreignIdentifier = this.foreignIdentifier;

    const defaultAttributes = options?.through || {};

    const promises: Array<Promise<any>> = [];
    const unassociatedTargets: TargetModel[] = [];
    // the 'through' table of these targets has changed
    const changedTargets: TargetModel[] = [];
    for (const newInstance of newTargets) {
      const existingThroughRow = currentThroughRows.find(throughRow => {
        // @ts-expect-error -- throughRow[] instead of .get because throughRows are loaded using 'raw'
        return throughRow[foreignIdentifier] === newInstance.get(targetKey);
      });

      if (!existingThroughRow) {
        unassociatedTargets.push(newInstance);

        continue;
      }

      // @ts-expect-error -- gets the content of the "through" table for this association that is set on the model
      const throughAttributes = newInstance[this.through.model.name];
      const attributes = { ...defaultAttributes, ...throughAttributes };

      if (Object.keys(attributes).some(attribute => {
        // @ts-expect-error existingThroughRow is raw
        return attributes[attribute] !== existingThroughRow[attribute];
      })) {
        changedTargets.push(newInstance);
      }
    }

    if (unassociatedTargets.length > 0) {
      const bulk = unassociatedTargets.map(unassociatedTarget => {
        // @ts-expect-error -- gets the content of the "through" table for this association that is set on the model
        const throughAttributes = unassociatedTarget[this.through.model.name];
        const attributes = { ...defaultAttributes, ...throughAttributes };

        attributes[identifier] = sourceInstance.get(sourceKey);
        attributes[foreignIdentifier] = unassociatedTarget.get(targetKey);

        // TODO: scopes should be joined using Op.and
        Object.assign(attributes, this.through.scope);

        return attributes;
      });

      promises.push(this.through.model.bulkCreate(bulk, { validate: true, ...options }));
    }

    for (const changedTarget of changedTargets) {
      // @ts-expect-error -- gets the content of the "through" table for this association that is set on the model
      let throughAttributes = changedTarget[this.through.model.name];
      const attributes = { ...defaultAttributes, ...throughAttributes };
      // Quick-fix for subtle bug when using existing objects that might have the through model attached (not as an attribute object)
      if (throughAttributes instanceof this.through.model) {
        throughAttributes = {};
      }

      promises.push(this.through.model.update(attributes, {
        ...options,
        where: {
          [identifier]: sourceInstance.get(sourceKey),
          [foreignIdentifier]: changedTarget.get(targetKey),
        },
      }));
    }

    await Promise.all(promises);
  }

  /**
   * Un-associate one or more instance(s).
   *
   * @param sourceInstance instance to un associate instances with
   * @param targetInstanceOrPks Can be an Instance or its primary key, or a mixed array of instances and primary keys
   * @param options Options passed to `through.destroy`
   */
  async remove(
    sourceInstance: SourceModel,
    targetInstanceOrPks: AllowArray<TargetModel | Exclude<TargetModel[TargetKey], any[]>>,
    options?: BelongsToManyRemoveAssociationMixinOptions,
  ): Promise<void> {
    const targetInstance = this.toInstanceArray(targetInstanceOrPks);

    const where = {
      [this.identifier]: sourceInstance.get(this.sourceKey),
      [this.foreignIdentifier]: targetInstance.map(newInstance => newInstance.get(this.targetKey)),
    };

    await this.through.model.destroy({ ...options, where });
  }

  /**
   * Create a new instance of the associated model and associate it with this.
   *
   * @param sourceInstance source instance
   * @param values values for target model
   * @param options Options passed to create and add
   */
  async create(
    sourceInstance: SourceModel,
    // @ts-expect-error -- {} is not always assignable to 'values', but Target.create will enforce this, not us.
    values: CreationAttributes<TargetModel> = {},
    options: BelongsToManyCreateAssociationMixinOptions | BelongsToManyCreateAssociationMixinOptions['fields'] = {},
  ): Promise<TargetModel> {
    if (Array.isArray(options)) {
      options = {
        fields: options,
      };
    }

    if (this.scope) {
      Object.assign(values, this.scope);
      if (options.fields) {
        options.fields = [...options.fields, ...Object.keys(this.scope)];
      }
    }

    // Create the related model instance
    const newAssociatedObject = await this.target.create(values, options);

    await this.add(sourceInstance, newAssociatedObject, omit(options, ['fields']));

    return newAssociatedObject;
  }
}

// workaround https://github.com/evanw/esbuild/issues/1260
Object.defineProperty(BelongsToMany, 'name', {
  value: 'BelongsToMany',
});

function isThroughOptions<M extends Model>(val: any): val is ThroughOptions<M> {
  return isPlainObject(val) && 'model' in val;
}

function normalizeThroughOptions<M extends Model>(
  through: ThroughOptions<M>,
  sequelize: Sequelize,
): NormalizedThroughOptions<M> {
  if (isModelStatic<M>(through.model)) {
    return through as NormalizedThroughOptions<M>;
  }

  if (sequelize.isDefined(through.model)) {
    return {
      ...through,
      model: sequelize.model(through.model) as ModelStatic<M>,
    };
  }

  return {
    ...through,
    model: sequelize.define(through.model, {} as ModelAttributes<M>, {
      tableName: through.model,
      indexes: [], // we don't want indexes here (as referenced in #2416)
      paranoid: through.paranoid || false, // Default to non-paranoid join (referenced in #11991)
      validate: {}, // Don't propagate model-level validations
      timestamps: through.timestamps,
    }),
  };
}

/**
 * Used for the through table in n:m associations.
 *
 * Used in {@link BelongsToManyOptions.through}
 */
export interface ThroughOptions<ThroughModel extends Model> {
  /**
   * The model used to join both sides of the N:M association.
   * Can be a string if you want the model to be generated by sequelize.
   */
  model: ModelStatic<ThroughModel> | string;

  /**
   * See {@link ModelOptions.timestamps}
   */
  timestamps?: ModelOptions['timestamps'];

  /**
   * See {@link ModelOptions.paranoid}
   */
  paranoid?: ModelOptions['paranoid'];

  /**
   * A key/value set that will be used for association create and find defaults on the through model.
   * (Remember to add the attributes to the through model)
   */
  scope?: AssociationScope;

  /**
   * If true a unique key will be generated from the foreign keys used (might want to turn this off and create
   * specific unique keys when using scopes)
   *
   * @default true
   */
  unique?: boolean;
}

/**
 * Attributes for the join table
 */
export interface JoinTableAttributes {
  [attribute: string]: unknown;
}

type NormalizedBelongsToManyOptions<
  SourceKey extends string,
  TargetKey extends string,
  ThroughModel extends Model,
> =
  Omit<BelongsToManyOptions<SourceKey, TargetKey, ThroughModel>, 'though'>
  & { through: NormalizedThroughOptions<ThroughModel> };

type NormalizedThroughOptions<ThroughModel extends Model> = Omit<ThroughOptions<ThroughModel>, 'model'> & {
  model: ModelStatic<ThroughModel>,
};

/**
 * Options provided when associating models with belongsToMany relationship.
 *
 * Used by {@link Model.belongsToMany}.
 */
export interface BelongsToManyOptions<
  SourceKey extends string,
  TargetKey extends string,
  ThroughModel extends Model,
> extends MultiAssociationOptions<string> {
  /**
   * Configures this association on the target model.
   */
  inverse?: {
    as?: AssociationOptions<string>['as'],
    onDelete?: AssociationOptions<string>['onDelete'],
    onUpdate?: AssociationOptions<string>['onUpdate'],
  };

  /**
   * The name of the table that is used to join source and target in n:m associations. Can also be a
   * sequelize model if you want to define the junction table yourself and add extra attributes to it.
   */
  through: ModelStatic<any> | string | ThroughOptions<ThroughModel>;

  /**
   * The name of the foreign key in the join table (representing the target model) or an object representing
   * the type definition for the other column (see `Sequelize.define` for syntax). When using an object, you
   * can add a `name` property to set the name of the colum. Defaults to the name of target + primary key of
   * target
   */
  // TODO: in the future, this could become "inverse.foreignKey" instead
  otherKey?: string | ForeignKeyOptions<string>;

  /**
   * The name of the field to use as the key for the association in the source table. Defaults to the primary
   * key of the source table
   */
  sourceKey?: SourceKey;

  /**
   * The name of the field to use as the key for the association in the target table. Defaults to the primary
   * key of the target table
   */
  targetKey?: TargetKey;

  /**
   * Should the join model have timestamps
   */
  timestamps?: boolean;

  /**
   * The unique key name to override the autogenerated one when primary key is not present on through model
   */
  uniqueKey?: string;
}

/**
 * The options for the getAssociations mixin of the belongsToMany association.
 *
 * @see BelongsToManyGetAssociationsMixin
 */
export interface BelongsToManyGetAssociationsMixinOptions extends FindOptions<any> {
  /**
   * A list of the attributes from the join table that you want to select.
   */
  joinTableAttributes?: FindAttributeOptions;
  /**
   * Apply a scope on the related model, or remove its default scope by passing false.
   */
  scope?: string | boolean;

  /**
   * Apply a schema on the related model
   */
  schema?: string;
  schemaDelimiter?: string;

  through?: {
    where?: WhereOptions,
    paranoid?: boolean,
  };
}

/**
 * The getAssociations mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  getRoles: Sequelize.BelongsToManyGetAssociationsMixin<RoleInstance>;
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyGetAssociationsMixin<TModel> = (
  options?: BelongsToManyGetAssociationsMixinOptions
) => Promise<TModel[]>;

/**
 * The options for the setAssociations mixin of the belongsToMany association.
 *
 * @see BelongsToManySetAssociationsMixin
 */
export interface BelongsToManySetAssociationsMixinOptions
  extends FindOptions<any>,
    BulkCreateOptions<any>,
    InstanceUpdateOptions<any>,
    InstanceDestroyOptions {

  /**
   * Additional attributes for the join table.
   */
  through?: JoinTableAttributes;
}

/**
 * The setAssociations mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  setRoles: Sequelize.BelongsToManySetAssociationsMixin<RoleInstance, RoleId, UserRoleAttributes>;
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManySetAssociationsMixin<TModel, TModelPrimaryKey> = (
  newAssociations?: Array<TModel | TModelPrimaryKey>,
  options?: BelongsToManySetAssociationsMixinOptions
) => Promise<void>;

/**
 * The options for the addAssociations mixin of the belongsToMany association.
 *
 * @see BelongsToManyAddAssociationsMixin
 */
export interface BelongsToManyAddAssociationsMixinOptions
  extends FindOptions<any>,
    BulkCreateOptions<any>,
    InstanceUpdateOptions<any>,
    InstanceDestroyOptions {
  through?: JoinTableAttributes;
}

/**
 * The addAssociations mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  addRoles: Sequelize.BelongsToManyAddAssociationsMixin<RoleInstance, RoleId, UserRoleAttributes>;
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyAddAssociationsMixin<TModel, TModelPrimaryKey> = (
  newAssociations?: Array<TModel | TModelPrimaryKey>,
  options?: BelongsToManyAddAssociationsMixinOptions
) => Promise<void>;

/**
 * The options for the addAssociation mixin of the belongsToMany association.
 *
 * @see BelongsToManyAddAssociationMixin
 */
export interface BelongsToManyAddAssociationMixinOptions
  extends FindOptions<any>,
    BulkCreateOptions<any>,
    InstanceUpdateOptions<any>,
    InstanceDestroyOptions {
  through?: JoinTableAttributes;
}

/**
 * The addAssociation mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  addRole: Sequelize.BelongsToManyAddAssociationMixin<RoleInstance, RoleId, UserRoleAttributes>;
 *  // createRole...
 *  // removeRole...
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyAddAssociationMixin<TModel, TModelPrimaryKey> = (
  newAssociation?: TModel | TModelPrimaryKey,
  options?: BelongsToManyAddAssociationMixinOptions
) => Promise<void>;

/**
 * The options for the createAssociation mixin of the belongsToMany association.
 *
 * @see BelongsToManyCreateAssociationMixin
 */
export interface BelongsToManyCreateAssociationMixinOptions extends CreateOptions<any> {
  through?: JoinTableAttributes;
}
/**
 * The createAssociation mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  createRole: Sequelize.BelongsToManyCreateAssociationMixin<RoleAttributes, UserRoleAttributes>;
 *  // removeRole...
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyCreateAssociationMixin<TModel extends Model> = (
  values?: CreationAttributes<TModel>,
  options?: BelongsToManyCreateAssociationMixinOptions
) => Promise<TModel>;

/**
 * The options for the removeAssociation mixin of the belongsToMany association.
 *
 * @see BelongsToManyRemoveAssociationMixin
 */
export interface BelongsToManyRemoveAssociationMixinOptions extends InstanceDestroyOptions {}

/**
 * The removeAssociation mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  removeRole: Sequelize.BelongsToManyRemoveAssociationMixin<RoleInstance, RoleId>;
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyRemoveAssociationMixin<TModel, TModelPrimaryKey> = (
  oldAssociated?: TModel | TModelPrimaryKey,
  options?: BelongsToManyRemoveAssociationMixinOptions
) => Promise<void>;

/**
 * The options for the removeAssociations mixin of the belongsToMany association.
 *
 * @see BelongsToManyRemoveAssociationsMixin
 */
export interface BelongsToManyRemoveAssociationsMixinOptions extends InstanceDestroyOptions, InstanceDestroyOptions {}

/**
 * The removeAssociations mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  removeRoles: Sequelize.BelongsToManyRemoveAssociationsMixin<RoleInstance, RoleId>;
 *  // hasRole...
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyRemoveAssociationsMixin<TModel, TModelPrimaryKey> = (
  oldAssociateds?: Array<TModel | TModelPrimaryKey>,
  options?: BelongsToManyRemoveAssociationsMixinOptions
) => Promise<void>;

/**
 * The options for the hasAssociation mixin of the belongsToMany association.
 *
 * @see BelongsToManyHasAssociationMixin
 */
export interface BelongsToManyHasAssociationMixinOptions extends BelongsToManyGetAssociationsMixinOptions {}

/**
 * The hasAssociation mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  // removeRoles...
 *  hasRole: Sequelize.BelongsToManyHasAssociationMixin<RoleInstance, RoleId>;
 *  // hasRoles...
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyHasAssociationMixin<TModel, TModelPrimaryKey> = (
  target: TModel | TModelPrimaryKey,
  options?: BelongsToManyHasAssociationMixinOptions
) => Promise<boolean>;

/**
 * The options for the hasAssociations mixin of the belongsToMany association.
 *
 * @see BelongsToManyHasAssociationsMixin
 */
export interface BelongsToManyHasAssociationsMixinOptions extends BelongsToManyGetAssociationsMixinOptions {}

/**
 * The removeAssociations mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  // removeRoles
 *  // hasRole...
 *  hasRoles: Sequelize.BelongsToManyHasAssociationsMixin<RoleInstance, RoleId>;
 *  // countRoles...
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyHasAssociationsMixin<TModel, TModelPrimaryKey> = (
  targets: Array<TModel | TModelPrimaryKey>,
  options?: BelongsToManyHasAssociationsMixinOptions
) => Promise<boolean>;

/**
 * The options for the countAssociations mixin of the belongsToMany association.
 *
 * @see BelongsToManyCountAssociationsMixin
 */
export interface BelongsToManyCountAssociationsMixinOptions extends Transactionable, Filterable<any> {
  /**
   * Apply a scope on the related model, or remove its default scope by passing false.
   */
  scope?: string | boolean;
}

/**
 * The countAssociations mixin applied to models with belongsToMany.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsToMany(Role, { through: UserRole });
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRoles...
 *  // setRoles...
 *  // addRoles...
 *  // addRole...
 *  // createRole...
 *  // removeRole...
 *  // removeRoles...
 *  // hasRole...
 *  // hasRoles...
 *  countRoles: Sequelize.BelongsToManyCountAssociationsMixin;
 * }
 * ```
 *
 * @see https://sequelize.org/master/class/lib/associations/belongs-to-many.js~BelongsToMany.html
 * @see Instance
 */
export type BelongsToManyCountAssociationsMixin = (
  options?: BelongsToManyCountAssociationsMixinOptions
) => Promise<number>;
