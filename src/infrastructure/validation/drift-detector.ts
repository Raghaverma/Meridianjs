import type { Schema, SchemaDrift } from "../../core/types.js";

export class DriftDetector {
  detect(oldSchema: Schema, newSchema: Schema): SchemaDrift[] {
    const drifts: SchemaDrift[] = [];

    if (oldSchema.type !== newSchema.type) {
      drifts.push({
        type: "TYPE_CHANGED",
        field: "type",
        oldValue: oldSchema.type,
        newValue: newSchema.type,
        severity: "ERROR",
      });
    }

    if (oldSchema.type === "object" && newSchema.type === "object") {
      const oldProps = oldSchema.properties ?? {};
      const newProps = newSchema.properties ?? {};
      const oldRequired = new Set(oldSchema.required ?? []);
      const newRequired = new Set(newSchema.required ?? []);

      for (const field of Object.keys(oldProps)) {
        if (!(field in newProps)) {
          drifts.push({
            type: "FIELD_REMOVED",
            field,
            oldValue: oldProps[field],
            newValue: undefined,
            severity: "ERROR",
          });
        }
      }

      for (const field of Object.keys(newProps)) {
        if (field in oldProps) {
          const oldField = oldProps[field];
          const newField = newProps[field];

          if (oldField && newField) {
            if (oldField.type !== newField.type) {
              drifts.push({
                type: "TYPE_CHANGED",
                field,
                oldValue: oldField.type,
                newValue: newField.type,
                severity: "ERROR",
              });
            } else {
              // Same type — recurse to detect structural changes within
              const nested = this.detect(oldField, newField);
              for (const d of nested) {
                drifts.push({ ...d, field: `${field}.${d.field}` });
              }
            }
          }
        }
      }

      for (const field of oldRequired) {
        if (!newRequired.has(field)) {
          drifts.push({
            type: "REQUIRED_REMOVED",
            field,
            oldValue: true,
            newValue: false,
            severity: "WARNING",
          });
        }
      }

      for (const field of newRequired) {
        if (!oldRequired.has(field)) {
          drifts.push({
            type: "REQUIRED_ADDED",
            field,
            oldValue: false,
            newValue: true,
            severity: "WARNING",
          });
        }
      }
    }

    if (oldSchema.type === "array" && newSchema.type === "array") {
      if (oldSchema.items && newSchema.items) {
        const itemDrifts = this.detect(oldSchema.items, newSchema.items);

        drifts.push(
          ...itemDrifts.map((d) => ({
            ...d,
            field: `items.${d.field}`,
          })),
        );
      }
    }

    return drifts;
  }
}
