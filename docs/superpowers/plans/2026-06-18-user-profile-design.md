# User Profile Design

## Design Goals

1. **User Onboarding**: Help new users quickly set up their kontexta environment
2. **Context Awareness**: Provide AI agents with essential user information
3. **Seamless Integration**: Integrate smoothly with existing kontexta workflows
4. **Extensible**: Allow for future profile enhancements

## Architecture

### Core Components

#### Profile Module (`packages/core/src/profile/index.ts`)
- Manages profile structure and validation
- Provides functions for parsing, assembling, and repairing profiles
- Defines required sections and their canonical order

#### File Management (`packages/core/src/files/index.ts`)
- Auto-repair logic for profile files during creation
- Ensures profile consistency across all file operations

#### MCP Tool (`apps/mcp/src/profile-tool.ts`)
- Handles the `get_profile` tool for AI agents
- Provides profile data in a structured format

#### Web API (`apps/web/src/app/api/profile/route.ts`)
- REST endpoints for profile management
- Auto-repair functionality for profile updates

#### UI Components
- **Profile Banner** (`apps/web/src/components/file-list/profile-banner.tsx`): Amber notification bar for incomplete setup
- **First Run Wizard** (`apps/web/src/components/file-list/first-run-wizard.tsx`): 2-step onboarding dialog

### Data Flow

1. **User Interaction**: User accesses kontexta web UI
2. **Profile Check**: System checks for existing profile and onboarded agents
3. **UI Notification**: If incomplete, displays Profile Banner
4. **Wizard Launch**: User clicks "Resume setup" to launch First Run Wizard
5. **Profile Creation**: User fills out profile sections
6. **Agent Onboarding**: User selects and onboards an AI agent
7. **Profile Persistence**: Profile saved to `knowledge/profile.md`

## User Experience

### Initial State
- User opens kontexta dashboard
- Profile banner appears if profile or agent setup is incomplete
- First run wizard can be launched from banner

### Profile Setup Flow
1. **Step 1**: Profile creation form with all required sections
2. **Step 2**: Agent selection and onboarding

### Ongoing Usage
- Profile data is available to AI agents via `get_profile` tool
- Profile auto-repair ensures consistency
- Profile can be updated at any time

## Technical Implementation

### Profile Validation
- Required sections enforced at creation time
- Missing sections automatically inserted in canonical order
- Section bodies preserved during repair

### Auto-Repair Logic
- Applied during both `create_file` and `update_file` operations
- Maintains profile integrity without manual intervention
- Preserves existing content while adding missing sections

### Tool Integration
- `get_profile` tool available in MCP server
- Tool response includes existence status, content, and missing sections
- Tool provides helpful hints for new users

## Testing Strategy

### Unit Tests
- Profile module functions (`getMissingSections`, `repairProfile`, `assembleProfile`)
- Auto-repair logic in file operations
- MCP tool handler behavior

### Integration Tests
- Web API endpoints for profile creation and retrieval
- Full onboarding workflow
- Tool integration with AI agents

### UI Tests
- Profile banner visibility
- Wizard step navigation
- Form submission handling

## Performance Considerations

- Profile loading is lightweight (single file read)
- Auto-repair is optimized to only process when needed
- No impact on existing file operations

## Security Considerations

- Profile data stored locally only
- No external data transmission
- Profile files not included in version control by default

## Future Considerations

- Profile templates for different user types
- Profile sharing between team members
- Profile versioning and history
- Import/export functionality
