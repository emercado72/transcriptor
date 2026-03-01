# Transcriptor - Architecture Dictionary

## Shared Types (packages/shared/src/types/)

### eventTypes.ts
| Type | Description |
|------|-------------|
| EventId | string - Unique identifier for an assembly event |
| EventStatus | enum: detected, queued, preprocessing, transcribing, sectioning, redacting, assembling, reviewing, completed, failed |
| EventMetadata | Full event info: eventId, buildingName, buildingNit, city, date, eventType (ordinaria/extraordinaria), startTime, endTime |
| EventFolder | Google Drive folder reference: folderId, folderName, audioFiles[], votingFiles[], path |
| ClientConfig | Per-building configuration: buildingName, nit, towers, unitsPerTower, adminName, customTerms[] |

### sectionTypes.ts
| Type | Description |
|------|-------------|
| SectionId | string - Format: "00_encabezado", "01_preambulo", etc. |
| SectionStyle | enum: encabezado, subtituloApertura, preambulo, ordenDelDia, sectionTitle, paragraphBold, paragraphNormal, intervention, votingQuestion, votingResults, votingAnnouncement, firma |
| ContentBlock | Union type for all block types in a section |
| ParagraphBlock | { type: "paragraph", bold: boolean, text: string } |
| InterventionBlock | { type: "intervention", speaker: string, unit: string or null, text: string } |
| VotingQuestionBlock | { type: "votingQuestion", questionId: string, text: string } |
| VotingResultsBlock | { type: "votingResults", questionId: string, source: "robinson" } |
| VotingAnnouncementBlock | { type: "votingAnnouncement", bold: boolean, text: string } |
| ListItemBlock | { type: "listItem", text: string, bold: boolean } |
| SectionFile | Complete section: sectionId, sectionTitle, sectionStyle, order, content: ContentBlock[], metadata: SectionMetadata |
| SectionMetadata | { agent: string, timestamp: string, confidence: number, flags: string[] } |

### votingTypes.ts
| Type | Description |
|------|-------------|
| QuestionId | string - Identifier from Tecnoreuniones |
| QuestionType | enum: singleChoice, multiChoice, election |
| VotingSummary | { questionId, questionText, questionType, options: VotingOption[] } |
| VotingOption | { label: string, coefficientPct: number, attendeePct: number, nominal: number } |
| VotingDetail | { questionId, votes: IndividualVote[] } |
| IndividualVote | { unit: string, ownerName: string, delegateName: string, response: string, coefficientOwner: number, coefficientQuorum: number, nominal: number, time: string } |
| ElectionResult | { questionId, candidates: CandidateResult[] } |
| CandidateResult | { name: string, unit: string, coefficientSum: number, nominalSum: number } |
| AttendanceRecord | { tower: number, unit: string, ownerName: string, delegateName: string, coefficientExpected: number, coefficientPresent: number, checkInTime: string, status: AttendanceStatus } |
| AttendanceStatus | enum: presentInRoom, presentVirtual, delegatedProxy, absent |
| QuorumSnapshot | { timestamp: string, coefficientPct: number, unitsPresent: number, totalUnits: number } |

### jobTypes.ts
| Type | Description |
|------|-------------|
| JobId | string - Unique job identifier |
| JobStatus | enum: pending, processing, completed, failed, retrying |
| TranscriptionJob | { jobId, eventId, audioFilePath, status, scribeJobId, startedAt, completedAt } |
| PipelineJob | { jobId, eventId, status: EventStatus, stages: StageStatus[], createdAt, updatedAt } |
| StageStatus | { stage: EventStatus, status: JobStatus, agentName: string, startedAt, completedAt, error: string or null } |

---

## Robinson - Data Abstraction Layer (packages/robinson/src/)

### robinsonService.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| getEventMetadata(eventId) | EventId | EventMetadata | Fetches assembly event info from Tecnoreuniones |
| validateEvent(buildingName, date) | string, Date | EventMetadata or null | Checks if event exists in system |
| getQuorumSnapshots(eventId) | EventId | QuorumSnapshot[] | All quorum readings during event |
| getInitialQuorum(eventId) | EventId | QuorumSnapshot | Quorum at assembly opening |
| getFinalQuorum(eventId) | EventId | QuorumSnapshot | Quorum at assembly closing |
| getAttendanceList(eventId) | EventId | AttendanceRecord[] | Full attendance with check-in times and status |
| getQuestionList(eventId) | EventId | VotingSummary[] | All questions voted during event |
| getVotingResults(eventId, questionId) | EventId, QuestionId | VotingSummary | Consolidated results for one question |
| getVotingDetail(eventId, questionId) | EventId, QuestionId | VotingDetail | Individual vote records for one question |
| getElectionResults(eventId, questionId) | EventId, QuestionId | ElectionResult | Candidate rankings for elections |
| getNonVoters(eventId, questionId) | EventId, QuestionId | AttendanceRecord[] | Present attendees who did not vote |
| getOfficers(eventId) | EventId | OfficerRoles | President, secretary, verificadores |

### adapters/tecnoreunionesAdapter.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| fetchService(serviceId, params) | number, Record | any | Raw call to Tecnoreuniones PHP backend |
| mapAttendance(rawData) | any | AttendanceRecord[] | Transforms raw PHP response to typed records |
| mapVotingResults(rawData) | any | VotingSummary | Transforms raw voting response |
| mapVotingDetail(rawData) | any | VotingDetail | Transforms raw individual votes |
| mapQuorum(rawData) | any | QuorumSnapshot | Transforms raw quorum data |

### adapters/newSystemAdapter.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| (Same interface as tecnoreunionesAdapter) | | | Future replacement system adapter |

---

## Supervisor (packages/supervisor/src/)

### supervisorService.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| initPipeline(eventId, eventFolder) | EventId, EventFolder | PipelineJob | Creates new pipeline job and initializes stages |
| advanceStage(jobId, nextStage) | JobId, EventStatus | PipelineJob | Moves job to next processing stage |
| markStageComplete(jobId, stage) | JobId, EventStatus | PipelineJob | Marks a stage as completed |
| markStageFailed(jobId, stage, error) | JobId, EventStatus, string | PipelineJob | Records failure with error message |
| retryStage(jobId, stage) | JobId, EventStatus | PipelineJob | Retries a failed stage |
| getPipelineStatus(jobId) | JobId | PipelineJob | Returns current pipeline state |
| getActivePipelines() | none | PipelineJob[] | Lists all in-progress jobs |
| sendNotification(jobId, message) | JobId, string | void | Sends status update via configured channel |

### stateManager.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| saveState(jobId, state) | JobId, PipelineJob | void | Persists pipeline state to Redis |
| loadState(jobId) | JobId | PipelineJob | Loads pipeline state from Redis |
| listActiveJobs() | none | JobId[] | Returns all non-completed job IDs |
| cleanupCompletedJobs(olderThan) | Date | number | Removes old completed jobs, returns count |

---

## Yulieth - Intake Agent (packages/yulieth/src/)

### driveWatcher.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| startWatching(rootFolderId) | string | void | Begins polling Google Drive folder for changes |
| stopWatching() | none | void | Stops the polling loop |
| checkForNewEvents(rootFolderId) | string | EventFolder[] | Scans for new unprocessed event folders |
| validateEventFolder(folder) | EventFolder | ValidationResult | Checks folder has required audio files and naming convention |
| extractEventInfo(folderName) | string | { date: Date, buildingName: string } | Parses folder name to extract event details |

### jobQueue.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| enqueueEvent(eventFolder, eventMetadata) | EventFolder, EventMetadata | JobId | Adds validated event to processing queue |
| getQueueStatus() | none | QueueStats | Returns counts of pending/processing/completed jobs |
| getNextJob() | none | TranscriptionJob or null | Dequeues next pending job |

---

## Chucho - Audio Preprocessing (packages/chucho/src/)

### audioProcessor.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| preprocessAudio(inputPath, outputPath) | string, string | AudioInfo | Full preprocessing pipeline: mono + normalize + format |
| convertToMono(inputPath, outputPath) | string, string | void | Converts stereo/multi-channel to single channel |
| normalizeAudio(inputPath, outputPath) | string, string | void | Normalizes volume levels across recording |
| convertFormat(inputPath, outputPath, format) | string, string, AudioFormat | void | Converts to target format (wav/flac) |
| splitAtSilence(inputPath, outputDir, maxDuration) | string, string, number | string[] | Splits long recordings at silence points |
| getAudioInfo(filePath) | string | AudioInfo | Returns duration, channels, sample rate, format |
| estimateTranscriptionCost(audioInfo) | AudioInfo | CostEstimate | Estimates Scribe API cost based on duration |

### AudioFormat type: enum wav, flac, mp3
### AudioInfo type: { duration: number, channels: number, sampleRate: number, format: string, fileSizeBytes: number }
### CostEstimate type: { durationMinutes: number, estimatedCostUsd: number, provider: string }

---

## Jaime - QA and Sectioning (packages/jaime/src/)

### transcriptionManager.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| submitToScribe(audioPath, options) | string, ScribeOptions | ScribeJobId | Sends preprocessed audio to ElevenLabs Scribe |
| pollScribeStatus(scribeJobId) | string | ScribeStatus | Checks transcription job status |
| fetchScribeResult(scribeJobId) | string | ScribeTranscript | Downloads completed transcript |

### sectionMapper.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| mapTranscriptToSections(transcript, questionList) | ScribeTranscript, VotingSummary[] | RawSection[] | Identifies section boundaries using patterns and timestamps |
| identifySectionType(text, context) | string, MappingContext | SectionStyle | Classifies a text segment by section type |
| extractAgendaItems(transcript) | ScribeTranscript | string[] | Pulls out the orden del dia items |
| matchVotingSegments(transcript, questions) | ScribeTranscript, VotingSummary[] | VotingSegment[] | Correlates transcript moments with voting data by timestamp |
| extractInterventions(sectionText) | string | RawIntervention[] | Identifies speaker interventions within a section |
| identifySpeaker(text, attendanceList) | string, AttendanceRecord[] | SpeakerMatch | Matches spoken name to attendance record |

### transcriptionQa.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| analyzeTranscriptionQuality(sections) | RawSection[] | QaReport | Overall quality assessment of transcription |
| detectNonsenseWords(text, glossary) | string, GlossaryEntry[] | NonsenseFlag[] | Flags likely mis-transcribed words |
| suggestCorrections(flags, glossary) | NonsenseFlag[], GlossaryEntry[] | CorrectionSuggestion[] | Proposes corrections using glossary and context |
| validateProperNames(text, attendanceList) | string, AttendanceRecord[] | NameValidation[] | Cross-checks names against attendance roster |
| validateUnitNumbers(text, clientConfig) | string, ClientConfig | UnitValidation[] | Checks apartment numbers match building config |
| applyCorrections(text, corrections) | string, CorrectionSuggestion[] | string | Applies approved corrections to text |
| loadGlossary(clientId) | string | GlossaryEntry[] | Loads client-specific glossary of terms |

---

## Lina - Redaction Agent (packages/lina/src/)

### redactionEngine.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| redactSection(rawSection, templateConfig, context) | RawSection, TemplateConfig, RedactionContext | SectionFile | Processes one section through LLM to produce formal narrative |
| redactAllSections(rawSections, templateConfig, context) | RawSection[], TemplateConfig, RedactionContext | SectionFile[] | Processes all sections (can parallelize) |
| buildSectionPrompt(rawSection, templateConfig, context) | RawSection, TemplateConfig, RedactionContext | string | Constructs the LLM prompt for one section |
| validateRedaction(sectionFile, rawSection) | SectionFile, RawSection | RedactionValidation | Checks redacted output for completeness and accuracy |

### promptBuilder.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| loadSuperPrompt() | none | string | Loads the base superprompt template |
| buildContextBlock(eventMetadata, officers) | EventMetadata, OfficerRoles | string | Builds event context for prompt |
| buildSectionInstructions(sectionStyle) | SectionStyle | string | Gets specific instructions per section type |
| buildGlossaryBlock(glossary) | GlossaryEntry[] | string | Formats glossary for prompt inclusion |
| buildExampleBlock(sectionStyle) | SectionStyle | string | Gets example output for the section type |

### RedactionContext type: { eventMetadata: EventMetadata, officers: OfficerRoles, glossary: GlossaryEntry[], questionList: VotingSummary[], clientConfig: ClientConfig }

---

## Fannery - Document Assembly (packages/fannery/src/)

### documentAssembler.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| assembleActa(sectionFiles, votingData, templateConfig) | SectionFile[], VotingPackage, TemplateConfig | Buffer | Main assembly: produces .docx buffer from all inputs |
| loadTemplate(templateId) | string | TemplateConfig | Loads formatting template definition |
| writeSectionToDoc(doc, sectionFile, templateConfig) | DocxDocument, SectionFile, TemplateConfig | void | Renders one section into the document |
| saveToGoogleDrive(buffer, eventFolder, fileName) | Buffer, EventFolder, string | string | Uploads .docx to event folder, returns file ID |

### contentRenderer.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| renderParagraph(block, templateConfig) | ParagraphBlock, TemplateConfig | Paragraph | Creates formatted docx paragraph |
| renderIntervention(block, templateConfig) | InterventionBlock, TemplateConfig | Paragraph | Renders speaker intervention with name+unit formatting |
| renderListItem(block, templateConfig, numbering) | ListItemBlock, TemplateConfig, NumberingRef | Paragraph | Renders numbered list item |
| renderVotingQuestion(block, templateConfig) | VotingQuestionBlock, TemplateConfig | Paragraph | Renders voting question in bold |
| renderSignatureBlock(officers, templateConfig) | OfficerRoles, TemplateConfig | Paragraph[] | Renders closing signature section |

### tableBuilder.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| buildSummaryTable(votingSummary) | VotingSummary | Table | 4x4 voting results table (Respuestas, Coeficientes, Asistentes, Nominal) |
| buildElectionTable(electionResult) | ElectionResult | Table | Candidate ranking table (3 columns) |
| buildDetailVotingTable(votingDetail, questionText) | VotingDetail, string | Table | Full individual voting record (7 columns, 300+ rows) |
| buildAttendanceTable(attendanceList) | AttendanceRecord[] | Table | Full attendance table (7 columns, 400+ rows) |
| buildTableHeader(columns, style) | string[], TableStyle | TableRow | Creates formatted header row |
| buildTableRow(cells, style) | string[], TableStyle | TableRow | Creates formatted data row |

### documentSetup.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| createDocument(templateConfig) | TemplateConfig | DocxDocument | Initializes document with styles, header, footer, page setup |
| setupPageProperties(templateConfig) | TemplateConfig | SectionProperties | Page size, margins, orientation |
| setupHeader(templateConfig) | TemplateConfig | Header | "Tecnoreuniones.com" right-aligned 9pt |
| setupFooter(templateConfig) | TemplateConfig | Footer | "Pagina X de Y" centered 9pt |
| setupStyles(templateConfig) | TemplateConfig | StyleDefinitions | All paragraph and character styles |

---

## Gloria - Review Interface (packages/gloria/src/)

### reviewServer.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| startServer(port) | number | void | Starts the review web server |
| getDraftList() | none | DraftSummary[] | Lists all drafts pending review |
| getDraftDetail(jobId) | JobId | DraftDetail | Full draft with sections and flags |
| approveDraft(jobId) | JobId | void | Marks draft as approved, triggers final delivery |
| rejectSection(jobId, sectionId, comments) | JobId, SectionId, string | void | Sends section back for re-processing |
| getAudioSegment(jobId, startTime, endTime) | JobId, number, number | AudioStream | Streams audio segment for verification |

---

## Shared Utilities (packages/shared/src/utils/)

### logger.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| createLogger(agentName) | string | Logger | Creates agent-specific logger instance |
| log.info(message, data) | string, any | void | Info level log with agent prefix |
| log.warn(message, data) | string, any | void | Warning level log |
| log.error(message, error) | string, Error | void | Error level log with stack trace |

### googleDrive.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| initDriveClient(credentials) | GoogleCredentials | DriveClient | Initializes authenticated Drive client |
| listFolderContents(folderId) | string | DriveFile[] | Lists files in a Drive folder |
| downloadFile(fileId, destPath) | string, string | void | Downloads file from Drive to local path |
| uploadFile(sourcePath, folderId, fileName) | string, string, string | string | Uploads file to Drive folder, returns file ID |
| createFolder(parentId, folderName) | string, string | string | Creates folder in Drive, returns folder ID |

### config.ts
| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| loadClientConfig(clientId) | string | ClientConfig | Loads per-building configuration |
| loadGlossary(clientId) | string | GlossaryEntry[] | Loads client-specific term dictionary |
| loadDefaultGlossary() | none | GlossaryEntry[] | Loads default Colombian PH terms |
| getEnvConfig() | none | EnvConfig | Reads environment variables |
