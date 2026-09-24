package cn.lingshi.familytree.controller;

import cn.lingshi.familytree.dto.PageResponse;
import cn.lingshi.familytree.dto.PersonCreateRequest;
import cn.lingshi.familytree.dto.PersonResponse;
import cn.lingshi.familytree.dto.PersonUpdateRequest;
import cn.lingshi.familytree.service.PersonService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Positive;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/persons")
public class PersonController {
    private final PersonService personService;

    public PersonController(PersonService personService) {
        this.personService = personService;
    }

    @PostMapping
    public ResponseEntity<PersonResponse> create(@Valid @RequestBody PersonCreateRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(personService.create(request));
    }

    @GetMapping("/{id}")
    public PersonResponse getById(@PathVariable @Positive Long id) {
        return personService.getById(id);
    }

    @GetMapping
    public PageResponse<PersonResponse> list(
            @RequestParam @Positive Long familyId,
            @RequestParam(required = false) String name,
            @RequestParam(required = false) @Positive Integer generation,
            @RequestParam(defaultValue = "1") @Min(1) long page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) long size) {
        return personService.list(familyId, name, generation, page, size);
    }

    @PutMapping("/{id}")
    public PersonResponse update(@PathVariable @Positive Long id,
                                 @Valid @RequestBody PersonUpdateRequest request) {
        return personService.update(id, request);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> softDelete(@PathVariable @Positive Long id) {
        personService.softDelete(id);
        return ResponseEntity.noContent().build();
    }
}
