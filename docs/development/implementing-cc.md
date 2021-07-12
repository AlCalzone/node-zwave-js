# Implementing a Command Class

Make sure you have the [project snippets](https://marketplace.visualstudio.com/items?itemName=rebornix.project-snippets) extension for VSCode installed. Implementing a Command Class (CC) requires **a lot** of boilerplate code and you won't have fun without that extension.

1. Have the CC specification open - you'll need it.

1. Create a file in `packages/zwave-js/src/lib/commandclass/` named `<name-of-the-cc>CC.ts`

1. Use the `zwcc` snippet to generate the base class and the command enum.  
   The base class should be named like the CC, without spaces or punctuation and with `CC` appended. For example: `"Multilevel Toggle Switch"` → `MultilevelToggleSwitchCC`. The enum defining how each CC is named can be found in `packages/core/src/capabilities/CommandClasses.ts`.  
   Make sure to define which version of the CC is currently implemented, e.g. `@implementedVersion(2)` for version 2.

1. Define all available commands in the command enum. You'll find them in `SDS13548` in the `specs` directory. The names in the specs might need to be simplified, e.g. `Multilevel Toggle Switch Set` → `Set`.

1. Implement each command. There are a few snippets available to help you generate the classes:
   | Snippet name | Description |
   | --- | --- |
   | `zwcccmd` | Simple command which expects a response. The deserialization doesn't need to be implemented if the command is only sent not received. |
   | `zwccreport` | A response command that is received from a node (usually in response to a request). In the CC file, response commands must be placed before the requesting command. These commands **must** have a name that ends with `Report`. |
   | `zwccemptycmd` | A command that contains no payload (only CC and command identifier). The entire contents of the class may be removed if nothing needs to be done. |
   | `zwccemptyget` | Like `zwccemptycmd` but with an expected response. |
   | `zwcclog` | Should be used in each command to convert it into a log message. A variant is `zwcclogempty` which hides the default `payload` line if that is not of interest |
   | `zwccprop` | Can be used to generate the properties of a command which serve as values for consuming applications. |

1. Implement the CC API which is used by consuming libraries and the interview procedure. The snippet `zwccapi` generates the basic shape, `zwccsupp` generates the method used to define which commands are supported.

    - Each sent command should have a corresponding API method. The `zwccassert` snippet must be used in each method to check whether the corresponding command is supported.
    - CCs that can set values for a given value ID must have a `SET_VALUE` API. There is no snippet for that yet, best check other CCs how they use it.
    - CCs that can poll values for a given value ID must have a `POLL_VALUE` API. There is no snippet for that yet, best check other CCs how they use it.

    > [!NOTE] At this point, you'll likely notice that the API class is not yet available through `node.commandClasses`. To fix that, you need to build the project once using `yarn run build`.

1. Implement the interview procedure in the base class. This is defined for many CCs in the `SDS14223` document. The `zwccinterview` snippet generates some boilerplate for that, `zwccintreq` can be used to define which CCs must be interviewed before the current one.  
   Two things to keep in mind:

    - Some requests don't need to be made when a node was already interviewed - the necessary data should be read from the value DB.
    - Some devices don't respond to requests they should support. If those requests are not critical, it is best to ignore the resulting timeout with the `ignoreTimeout` method.

1. Check if the CC needs to be handled on the node or driver level. Some unsolicited messages may require an action when they are received (in `ZWaveNode.handleCommand`). Others even require deep integration into the driver (e.g. Transport Encapsulation CCs)
